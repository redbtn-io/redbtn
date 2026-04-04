"use strict";
/**
 * MCP Client
 * Implements JSON-RPC 2.0 client over Redis transport
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
exports.McpClient = void 0;
class McpClient {
    constructor(redis, serverName) {
        this.pendingRequests = new Map();
        this.requestId = 0;
        this.redis = redis;
        this.subscriber = redis.duplicate();
        this.serverName = serverName;
        this.requestChannel = `mcp:server:${serverName}:request`;
        this.responseChannel = `mcp:server:${serverName}:response`;
    }
    /**
     * Connect to MCP server
     */
    connect() {
        return __awaiter(this, void 0, void 0, function* () {
            // Subscribe to response channel
            yield this.subscriber.subscribe(this.responseChannel);
            // Listen for responses
            this.subscriber.on('message', (channel, message) => {
                if (channel === this.responseChannel) {
                    this.handleResponse(message);
                }
            });
        });
    }
    /**
     * Disconnect from MCP server
     */
    disconnect() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.subscriber.unsubscribe(this.responseChannel);
            yield this.subscriber.quit();
        });
    }
    /**
     * Initialize connection with server
     */
    initialize(clientInfo) {
        return __awaiter(this, void 0, void 0, function* () {
            const params = {
                protocolVersion: '2025-06-18',
                capabilities: {
                    elicitation: {},
                },
                clientInfo,
            };
            const result = yield this.sendRequest('initialize', params);
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
     * Call a tool
     */
    callTool(name, args, meta) {
        return __awaiter(this, void 0, void 0, function* () {
            const params = {
                name,
                arguments: args,
                _meta: meta,
            };
            return yield this.sendRequest('tools/call', params);
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
            return new Promise((resolve, reject) => {
                this.pendingRequests.set(id, { resolve, reject });
                // Send request
                this.redis.publish(this.requestChannel, JSON.stringify(request)).catch(reject);
                // Timeout after 30 seconds
                setTimeout(() => {
                    if (this.pendingRequests.has(id)) {
                        this.pendingRequests.delete(id);
                        reject(new Error(`Request timeout: ${method}`));
                    }
                }, 30000);
            });
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
            yield this.redis.publish(this.requestChannel, JSON.stringify(notification));
        });
    }
    /**
     * Handle incoming response
     */
    handleResponse(message) {
        try {
            const response = JSON.parse(message);
            // Check if it's a notification
            if (!('id' in response)) {
                this.handleNotification(response);
                return;
            }
            // Handle response
            const { id, result, error } = response;
            const pending = this.pendingRequests.get(id);
            if (!pending) {
                // Silently ignore - likely a race condition with cleanup
                return;
            }
            this.pendingRequests.delete(id);
            if (error) {
                pending.reject(new Error(`${error.message} (code: ${error.code})`));
            }
            else {
                pending.resolve(result);
            }
        }
        catch (error) {
            console.error(`[MCP Client] Error handling response:`, error);
        }
    }
    /**
     * Handle incoming notification
     */
    handleNotification(notification) {
        const { method, params } = notification;
        switch (method) {
            case 'notifications/tools/list_changed':
                console.log(`[MCP Client] ${this.serverName} tools list changed`);
                break;
            default:
                console.log(`[MCP Client] ${this.serverName} notification: ${method}`, params);
        }
    }
}
exports.McpClient = McpClient;
