"use strict";
/**
 * MCP Server Base Class
 * Implements JSON-RPC 2.0 over Redis transport
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
exports.McpServer = void 0;
class McpServer {
    constructor(redis, name, version) {
        this.capabilities = {};
        this.tools = new Map();
        this.running = false;
        this.redis = redis;
        // Create a separate Redis connection for publishing
        this.publishRedis = redis.duplicate();
        this.serverInfo = { name, version };
        this.requestChannel = `mcp:server:${name}:request`;
        this.responseChannel = `mcp:server:${name}:response`;
    }
    /**
     * Start the MCP server
     */
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            console.log(`[MCP Server] Starting ${this.serverInfo.name} v${this.serverInfo.version}`);
            // Call setup to define tools and capabilities
            yield this.setup();
            console.log(`[MCP Server] ${this.serverInfo.name} registered ${this.tools.size} tools`);
            // Subscribe to request channel
            yield this.redis.subscribe(this.requestChannel);
            this.running = true;
            // Listen for messages
            this.redis.on('message', (channel, message) => __awaiter(this, void 0, void 0, function* () {
                if (channel === this.requestChannel) {
                    yield this.handleMessage(message);
                }
            }));
            console.log(`[MCP Server] ${this.serverInfo.name} listening on ${this.requestChannel}`);
        });
    }
    /**
     * Stop the MCP server
     */
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            console.log(`[MCP Server] Stopping ${this.serverInfo.name}`);
            this.running = false;
            yield this.redis.unsubscribe(this.requestChannel);
            yield this.publishRedis.quit();
            console.log(`[MCP Server] ${this.serverInfo.name} stopped`);
        });
    }
    /**
     * Define a tool
     */
    defineTool(tool) {
        this.tools.set(tool.name, tool);
    }
    /**
     * Handle incoming JSON-RPC message
     */
    handleMessage(message) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const request = JSON.parse(message);
                // Check if it's a notification (no id field)
                if (!('id' in request)) {
                    // Handle notification (no response needed)
                    yield this.handleNotification(request);
                    return;
                }
                // Handle request and send response
                const response = yield this.handleRequest(request);
                yield this.sendResponse(response);
            }
            catch (error) {
                console.error(`[MCP Server] ${this.serverInfo.name} error handling message:`, error);
            }
        });
    }
    /**
     * Handle JSON-RPC request
     */
    handleRequest(request) {
        return __awaiter(this, void 0, void 0, function* () {
            const { id, method, params } = request;
            try {
                let result;
                switch (method) {
                    case 'initialize':
                        result = yield this.handleInitialize(params);
                        break;
                    case 'tools/list':
                        result = yield this.handleToolsList();
                        break;
                    case 'tools/call':
                        result = yield this.handleToolCall(params);
                        break;
                    default:
                        throw {
                            code: -32601,
                            message: `Method not found: ${method}`,
                        };
                }
                return {
                    jsonrpc: '2.0',
                    id,
                    result,
                };
            }
            catch (error) {
                return {
                    jsonrpc: '2.0',
                    id,
                    error: {
                        code: error.code || -32603,
                        message: error.message || 'Internal error',
                        data: error.data,
                    },
                };
            }
        });
    }
    /**
     * Handle notification (no response)
     */
    handleNotification(notification) {
        return __awaiter(this, void 0, void 0, function* () {
            const { method } = notification;
            switch (method) {
                case 'notifications/initialized':
                    console.log(`[MCP Server] ${this.serverInfo.name} client initialized`);
                    break;
                default:
                    console.log(`[MCP Server] ${this.serverInfo.name} unknown notification: ${method}`);
            }
        });
    }
    /**
     * Handle initialize request
     */
    handleInitialize(params) {
        return __awaiter(this, void 0, void 0, function* () {
            console.log(`[MCP Server] ${this.serverInfo.name} initializing with client: ${params.clientInfo.name}`);
            return {
                protocolVersion: '2025-06-18',
                capabilities: this.capabilities,
                serverInfo: this.serverInfo,
            };
        });
    }
    /**
     * Handle tools/list request
     */
    handleToolsList() {
        return __awaiter(this, void 0, void 0, function* () {
            return {
                tools: Array.from(this.tools.values()),
            };
        });
    }
    /**
     * Handle tools/call request
     */
    handleToolCall(params) {
        return __awaiter(this, void 0, void 0, function* () {
            const { name, arguments: args, _meta } = params;
            if (!this.tools.has(name)) {
                throw {
                    code: -32602,
                    message: `Tool not found: ${name}`,
                };
            }
            console.log(`[MCP Server] ${this.serverInfo.name} executing tool: ${name}`);
            return yield this.executeTool(name, args, _meta);
        });
    }
    /**
     * Send JSON-RPC response
     */
    sendResponse(response) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.publishRedis.publish(this.responseChannel, JSON.stringify(response));
        });
    }
    /**
     * Send JSON-RPC notification
     */
    sendNotification(method, params) {
        return __awaiter(this, void 0, void 0, function* () {
            const notification = {
                jsonrpc: '2.0',
                method,
                params,
            };
            yield this.publishRedis.publish(this.responseChannel, JSON.stringify(notification));
        });
    }
}
exports.McpServer = McpServer;
