"use strict";
/**
 * System MCP Server - SSE Transport
 * Provides HTTP fetch capabilities. Command execution removed for security
 * — use the native ssh_shell tool for remote command execution instead.
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
exports.SystemServerSSE = void 0;
const server_sse_1 = require("../server-sse");
class SystemServerSSE extends server_sse_1.McpServerSSE {
    constructor(name, version, port = 3002) {
        super(name, version, port, '/mcp');
    }
    /**
     * Setup tools
     */
    setup() {
        return __awaiter(this, void 0, void 0, function* () {
            this.defineTool({
                name: 'fetch_url',
                description: 'Make an HTTP request to a URL. Supports GET, POST, PUT, PATCH, DELETE with custom headers and body. Returns the response status, headers, and body.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The URL to fetch'
                        },
                        method: {
                            type: 'string',
                            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
                            description: 'HTTP method (default: GET)'
                        },
                        headers: {
                            type: 'object',
                            description: 'Request headers as key-value pairs',
                            additionalProperties: { type: 'string' }
                        },
                        body: {
                            type: 'string',
                            description: 'Request body (usually JSON string for POST/PUT)'
                        },
                        timeout: {
                            type: 'number',
                            description: 'Request timeout in milliseconds (default: 300000, max: 900000)'
                        }
                    },
                    required: ['url']
                }
            });
            this.capabilities = {
                tools: {
                    listChanged: false
                }
            };
        });
    }
    /**
     * Execute tool
     */
    executeTool(name, args) {
        return __awaiter(this, void 0, void 0, function* () {
            if (name === 'fetch_url') {
                return yield this.fetchUrl(args);
            }
            throw new Error(`Unknown tool: ${name}`);
        });
    }
    /**
     * Fetch a URL via HTTP
     */
    fetchUrl(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const url = (args.url || '').trim();
            const method = (args.method || 'GET').toUpperCase();
            const headers = args.headers || {};
            const body = args.body;
            const timeout = Math.min(Number(args.timeout) || 300000, 900000);
            if (!url) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'No URL provided' }) }], isError: true };
            }
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeout);
                const fetchHeaders = Object.assign({}, headers);
                if (body && !fetchHeaders['Content-Type'] && !fetchHeaders['content-type']) {
                    fetchHeaders['Content-Type'] = 'application/json';
                }
                const response = yield fetch(url, {
                    method,
                    headers: fetchHeaders,
                    body: body || undefined,
                    signal: controller.signal,
                });
                clearTimeout(timer);
                const responseText = yield response.text();
                let output;
                try {
                    const json = JSON.parse(responseText);
                    output = JSON.stringify(json, null, 2);
                }
                catch (_a) {
                    output = responseText;
                }
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: response.status,
                                statusText: response.statusText,
                                body: output.length > 500000 ? output.slice(0, 500000) + '...(truncated)' : output,
                            })
                        }]
                };
            }
            catch (error) {
                const errorMessage = error.name === 'AbortError'
                    ? `Request timed out after ${timeout}ms`
                    : error.message || 'Unknown error';
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: `HTTP request failed: ${errorMessage}` }) }],
                    isError: true
                };
            }
        });
    }
}
exports.SystemServerSSE = SystemServerSSE;
