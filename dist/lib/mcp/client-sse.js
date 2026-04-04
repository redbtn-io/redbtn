"use strict";
/**
 * MCP Client - SSE Transport
 * Connects to MCP servers over HTTP/SSE
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
exports.McpClientSSE = void 0;
class McpClientSSE {
    constructor(serverUrl, serverName) {
        this.requestId = 0;
        this.serverUrl = serverUrl;
        this.serverName = serverName;
        this.sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    /**
     * Connect to MCP server (just validates connection)
     */
    connect() {
        return __awaiter(this, void 0, void 0, function* () {
            // Test connection with health check
            try {
                const response = yield fetch(`${this.serverUrl}/health`);
                if (!response.ok) {
                    throw new Error(`Server health check failed: ${response.status}`);
                }
                console.log(`[MCP Client] Connected to ${this.serverName} at ${this.serverUrl}`);
            }
            catch (error) {
                throw new Error(`Failed to connect to ${this.serverName}: ${error}`);
            }
        });
    }
    /**
     * Disconnect from MCP server
     */
    disconnect() {
        return __awaiter(this, void 0, void 0, function* () {
            // Nothing to do for HTTP transport
        });
    }
    /**
     * Initialize connection with server
     */
    initialize(clientInfo) {
        return __awaiter(this, void 0, void 0, function* () {
            const result = yield this.sendRequest('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {
                    elicitation: {},
                },
                clientInfo,
            });
            // Send initialized notification
            yield this.sendNotification('notifications/initialized');
            return result;
        });
    }
    /**
     * List available tools
     */
    listTools() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.sendRequest('tools/list');
        });
    }
    /**
     * Call a tool
     */
    callTool(name, args, meta) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.sendRequest('tools/call', {
                name,
                arguments: args,
                _meta: meta,
            });
        });
    }
    /**
     * List available resources
     */
    listResources() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.sendRequest('resources/list');
        });
    }
    /**
     * Read a resource
     */
    readResource(params) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.sendRequest('resources/read', params);
        });
    }
    /**
     * Send JSON-RPC request
     */
    sendRequest(method, params) {
        return __awaiter(this, void 0, void 0, function* () {
            const id = ++this.requestId;
            const request = {
                jsonrpc: '2.0',
                id,
                method,
                params,
            };
            try {
                const response = yield fetch(`${this.serverUrl}/message`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(request),
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                const result = yield response.json();
                if (result.error) {
                    throw new Error(`${result.error.message} (code: ${result.error.code})`);
                }
                return result.result;
            }
            catch (error) {
                throw new Error(`Request to ${this.serverName} failed: ${error}`);
            }
        });
    }
    /**
     * Send JSON-RPC notification (no response expected)
     */
    sendNotification(method, params) {
        return __awaiter(this, void 0, void 0, function* () {
            const notification = {
                jsonrpc: '2.0',
                method,
                params,
            };
            yield fetch(`${this.serverUrl}/message`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(notification),
            });
        });
    }
}
exports.McpClientSSE = McpClientSSE;
