"use strict";
/**
 * MCP Server Registry
 * Tracks available MCP servers and their capabilities
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpRegistry = void 0;
const client_sse_1 = require("./client-sse");
/**
 * MCP Registry for discovering and managing server connections
 */
class McpRegistry {
    constructor(messageQueue) {
        this.clients = new Map();
        this.servers = new Map();
        // messageQueue is optional - if provided, enables tool event publishing
        this.messageQueue = messageQueue;
    }
    /**
     * Register a server and connect to it
     */
    registerServer(config) {
        return __awaiter(this, void 0, void 0, function* () {
            const { name, url } = config;
            if (this.clients.has(name)) {
                console.log(`[Registry] Server ${name} already registered`);
                return;
            }
            const client = new client_sse_1.McpClientSSE(url, name);
            try {
                // Connect and initialize
                yield client.connect();
                const initResult = yield client.initialize({
                    name: 'red-ai-client',
                    version: '1.0.0'
                });
                // Get tools list
                const toolsList = yield client.listTools();
                // Store registration
                const registration = {
                    name: initResult.serverInfo.name,
                    version: initResult.serverInfo.version,
                    tools: toolsList.tools,
                    capabilities: initResult.capabilities,
                    url
                };
                this.clients.set(name, client);
                this.servers.set(name, registration);
                console.log(`[Registry] Registered ${name} with ${toolsList.tools.length} tools`);
            }
            catch (error) {
                console.error(`[Registry] Failed to register server ${name}:`, error);
                throw error;
            }
        });
    }
    /**
     * Unregister a server
     */
    unregisterServer(serverName) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = this.clients.get(serverName);
            if (client) {
                yield client.disconnect();
                this.clients.delete(serverName);
                this.servers.delete(serverName);
            }
        });
    }
    /**
     * Get client for a server
     */
    getClient(serverName) {
        return this.clients.get(serverName);
    }
    /**
     * Get server registration info
     */
    getServer(serverName) {
        return this.servers.get(serverName);
    }
    /**
     * Get all registered servers
     */
    getAllServers() {
        return Array.from(this.servers.values());
    }
    /**
     * Get all server names
     */
    getAllServerNames() {
        return Array.from(this.servers.keys());
    }
    /**
     * Find tool by name across all servers
     */
    findTool(toolName) {
        for (const [serverName, registration] of this.servers.entries()) {
            const tool = registration.tools.find(t => t.name === toolName);
            if (tool) {
                return { server: serverName, tool };
            }
        }
        return undefined;
    }
    /**
     * Get all tools from all servers
     */
    getAllTools() {
        const allTools = [];
        for (const [serverName, registration] of this.servers.entries()) {
            for (const tool of registration.tools) {
                allTools.push({ server: serverName, tool });
            }
        }
        return allTools;
    }
    /**
     * Call a tool (automatically finds the right server)
     * Wraps tool execution with event publishing for frontend display
     * (skips event publishing for infrastructure tools like context)
     */
    callTool(toolName, args, meta) {
        return __awaiter(this, void 0, void 0, function* () {
            const found = this.findTool(toolName);
            if (!found) {
                throw new Error(`Tool not found: ${toolName}`);
            }
            console.log(`[Registry] Calling tool: ${toolName} on server: ${found.server}, role: ${args.role}`);
            const client = this.clients.get(found.server);
            if (!client) {
                throw new Error(`Client not found for server: ${found.server}`);
            }
            // Skip event publishing for infrastructure tools (context, rag storage)
            const isInfrastructureTool = found.server === 'context' ||
                (found.server === 'rag' && ['add_document', 'delete_documents'].includes(toolName));
            // Publish tool start event if messageId is provided and not infrastructure
            const toolId = `${toolName}_${Date.now()}`;
            if ((meta === null || meta === void 0 ? void 0 : meta.messageId) && this.messageQueue && !isInfrastructureTool) {
                yield this.messageQueue.publishToolEvent(meta.messageId, {
                    type: 'tool_start',
                    toolId,
                    toolType: toolName,
                    toolName,
                    timestamp: Date.now(),
                    metadata: meta
                });
            }
            const startTime = Date.now();
            try {
                const result = yield client.callTool(toolName, args, meta);
                const duration = Date.now() - startTime;
                console.log(`[Registry] Tool ${toolName} returned in ${duration}ms, isError: ${result === null || result === void 0 ? void 0 : result.isError}`);
                // Publish tool complete event
                if ((meta === null || meta === void 0 ? void 0 : meta.messageId) && this.messageQueue && !isInfrastructureTool) {
                    yield this.messageQueue.publishToolEvent(meta.messageId, {
                        type: 'tool_complete',
                        toolId,
                        toolType: toolName,
                        toolName,
                        timestamp: Date.now(),
                        result: result,
                        metadata: Object.assign(Object.assign({}, meta), { duration })
                    });
                }
                return result;
            }
            catch (error) {
                const duration = Date.now() - startTime;
                // Publish tool error event
                if ((meta === null || meta === void 0 ? void 0 : meta.messageId) && this.messageQueue && !isInfrastructureTool) {
                    yield this.messageQueue.publishToolEvent(meta.messageId, {
                        type: 'tool_error',
                        toolId,
                        toolType: toolName,
                        toolName,
                        timestamp: Date.now(),
                        error: error instanceof Error ? error.message : String(error),
                        metadata: Object.assign(Object.assign({}, meta), { duration })
                    });
                }
                throw error;
            }
        });
    }
    /**
     * Disconnect all clients
     */
    disconnectAll() {
        return __awaiter(this, void 0, void 0, function* () {
            console.log('[Registry] Disconnecting all clients');
            for (const [serverName, client] of this.clients.entries()) {
                try {
                    yield client.disconnect();
                    console.log(`[Registry] Disconnected from ${serverName}`);
                }
                catch (error) {
                    console.error(`[Registry] Error disconnecting from ${serverName}:`, error);
                }
            }
            this.clients.clear();
            this.servers.clear();
        });
    }
}
exports.McpRegistry = McpRegistry;
