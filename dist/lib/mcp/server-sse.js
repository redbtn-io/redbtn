"use strict";
/**
 * MCP Server Base Class - SSE Transport
 * Implements MCP protocol over HTTP with Server-Sent Events
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpServerSSE = void 0;
const express_1 = __importDefault(require("express"));
class McpServerSSE {
    constructor(name, version, port, endpoint = '/mcp') {
        this.server = null;
        this.capabilities = {};
        this.tools = new Map();
        this.resources = new Map();
        this.running = false;
        this.sseConnections = new Map();
        this.serverInfo = { name, version };
        this.port = port;
        this.endpoint = endpoint;
        this.app = (0, express_1.default)();
        this.app.use(express_1.default.json());
        this.setupRoutes();
    }
    /**
     * Setup HTTP routes for MCP protocol
     */
    setupRoutes() {
        // SSE endpoint for receiving messages from server
        this.app.get(`${this.endpoint}/sse`, (req, res) => {
            const clientId = req.query.sessionId || `client-${Date.now()}`;
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Access-Control-Allow-Origin', '*');
            this.sseConnections.set(clientId, res);
            // Send initial connection event
            res.write(`data: ${JSON.stringify({ type: 'connection', sessionId: clientId })}\n\n`);
            req.on('close', () => {
                this.sseConnections.delete(clientId);
            });
        });
        // POST endpoint for receiving JSON-RPC requests
        this.app.post(`${this.endpoint}/message`, (req, res) => __awaiter(this, void 0, void 0, function* () {
            try {
                const request = req.body;
                const response = yield this.handleRequest(request);
                res.json(response);
            }
            catch (error) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: `Internal error: ${error}`
                    },
                    id: req.body.id || null
                });
            }
        }));
        // Health check
        this.app.get(`${this.endpoint}/health`, (req, res) => {
            res.json({
                status: 'ok',
                server: this.serverInfo,
                tools: Array.from(this.tools.keys()),
                resources: Array.from(this.resources.keys())
            });
        });
    }
    /**
     * Start the MCP server
     */
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            console.log(`[MCP Server] Starting ${this.serverInfo.name} v${this.serverInfo.version}`);
            // Call setup to define tools and capabilities
            yield this.setup();
            console.log(`[MCP Server] ${this.serverInfo.name} registered ${this.tools.size} tools, ${this.resources.size} resources`);
            // Start HTTP server
            return new Promise((resolve) => {
                this.server = this.app.listen(this.port, () => {
                    this.running = true;
                    console.log(`[MCP Server] ${this.serverInfo.name} listening on http://localhost:${this.port}${this.endpoint}`);
                    resolve();
                });
            });
        });
    }
    /**
     * Stop the MCP server
     */
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            console.log(`[MCP Server] Stopping ${this.serverInfo.name}`);
            this.running = false;
            // Close all SSE connections
            for (const [clientId, res] of this.sseConnections.entries()) {
                res.end();
            }
            this.sseConnections.clear();
            // Close HTTP server
            if (this.server) {
                yield new Promise((resolve) => {
                    this.server.close(() => {
                        console.log(`[MCP Server] ${this.serverInfo.name} stopped`);
                        resolve();
                    });
                });
            }
        });
    }
    /**
     * Read resource - subclasses override to implement resource reading
     */
    readResource(uri) {
        return __awaiter(this, void 0, void 0, function* () {
            throw new Error(`Resource reading not implemented: ${uri}`);
        });
    }
    /**
     * Define a tool
     */
    defineTool(tool) {
        this.tools.set(tool.name, tool);
    }
    /**
     * Define a resource
     */
    defineResource(resource) {
        this.resources.set(resource.uri, resource);
    }
    /**
     * Handle incoming JSON-RPC request
     */
    handleRequest(request) {
        return __awaiter(this, void 0, void 0, function* () {
            const { jsonrpc, id, method, params } = request;
            // Validate JSON-RPC 2.0
            if (jsonrpc !== '2.0') {
                return {
                    jsonrpc: '2.0',
                    error: {
                        code: -32600,
                        message: 'Invalid Request: jsonrpc must be "2.0"'
                    },
                    id: id || null
                };
            }
            try {
                let result;
                switch (method) {
                    case 'initialize':
                        result = yield this.handleInitialize(params);
                        break;
                    case 'tools/list':
                        result = yield this.handleListTools();
                        break;
                    case 'tools/call':
                        result = yield this.handleCallTool(params);
                        break;
                    case 'resources/list':
                        result = yield this.handleListResources();
                        break;
                    case 'resources/read':
                        result = yield this.handleReadResource(params);
                        break;
                    case 'notifications/initialized':
                        // Acknowledge initialization
                        return { jsonrpc: '2.0', result: {}, id };
                    default:
                        return {
                            jsonrpc: '2.0',
                            error: {
                                code: -32601,
                                message: `Method not found: ${method}`
                            },
                            id
                        };
                }
                return {
                    jsonrpc: '2.0',
                    result,
                    id
                };
            }
            catch (error) {
                console.error(`[MCP Server] ${this.serverInfo.name} error handling ${method}:`, error);
                return {
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: error instanceof Error ? error.message : String(error)
                    },
                    id
                };
            }
        });
    }
    /**
     * Handle initialize request
     */
    handleInitialize(params) {
        return __awaiter(this, void 0, void 0, function* () {
            return {
                protocolVersion: '2024-11-05',
                capabilities: this.capabilities,
                serverInfo: this.serverInfo,
            };
        });
    }
    /**
     * Handle tools/list request
     */
    handleListTools() {
        return __awaiter(this, void 0, void 0, function* () {
            return {
                tools: Array.from(this.tools.values()),
            };
        });
    }
    /**
     * Handle tools/call request
     */
    handleCallTool(params) {
        return __awaiter(this, void 0, void 0, function* () {
            const { name, arguments: args, _meta } = params;
            if (!this.tools.has(name)) {
                throw new Error(`Tool not found: ${name}`);
            }
            return yield this.executeTool(name, args, _meta);
        });
    }
    /**
     * Handle resources/list request
     */
    handleListResources() {
        return __awaiter(this, void 0, void 0, function* () {
            return {
                resources: Array.from(this.resources.values())
            };
        });
    }
    /**
     * Handle resources/read request
     */
    handleReadResource(params) {
        return __awaiter(this, void 0, void 0, function* () {
            const { uri } = params;
            if (!this.resources.has(uri)) {
                throw new Error(`Resource not found: ${uri}`);
            }
            const contents = yield this.readResource(uri);
            return { contents };
        });
    }
    /**
     * Send event to all connected clients (for future notifications)
     */
    sendEventToAll(event, data) {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const [clientId, res] of this.sseConnections.entries()) {
            try {
                res.write(message);
            }
            catch (error) {
                console.error(`Failed to send to client ${clientId}:`, error);
                this.sseConnections.delete(clientId);
            }
        }
    }
}
exports.McpServerSSE = McpServerSSE;
