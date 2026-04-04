#!/usr/bin/env tsx
"use strict";
/**
 * MCP Servers Launcher - SSE Transport
 * Starts all MCP tool servers as HTTP/SSE endpoints
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
const web_sse_1 = require("./lib/mcp/servers/web-sse");
const system_sse_1 = require("./lib/mcp/servers/system-sse");
const rag_sse_1 = require("./lib/mcp/servers/rag-sse");
const context_sse_1 = require("./lib/mcp/servers/context-sse");
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('[MCP Launcher] Starting MCP servers with SSE transport...');
        const servers = [];
        try {
            // Web Server (port 3001)
            const webServer = new web_sse_1.WebServerSSE('web', '1.0.0', 3001);
            yield webServer.start();
            servers.push(webServer);
            console.log('[MCP Launcher] ✓ Web server started on http://localhost:3001/mcp');
            // System Server (port 3002)
            const systemServer = new system_sse_1.SystemServerSSE('system', '1.0.0', 3002);
            yield systemServer.start();
            servers.push(systemServer);
            console.log('[MCP Launcher] ✓ System server started on http://localhost:3002/mcp');
            // RAG Server (port 3003)
            const ragServer = new rag_sse_1.RagServerSSE('rag', '1.0.0', 3003);
            yield ragServer.start();
            servers.push(ragServer);
            console.log('[MCP Launcher] ✓ RAG server started on http://localhost:3003/mcp');
            // Context Server (port 3004)
            const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
            const contextServer = new context_sse_1.ContextServerSSE('context', '1.0.0', 3004, redisUrl);
            yield contextServer.start();
            servers.push(contextServer);
            console.log('[MCP Launcher] ✓ Context server started on http://localhost:3004/mcp');
            console.log('\n[MCP Launcher] All servers started successfully');
            console.log('[MCP Launcher] Protocol: JSON-RPC 2.0 over HTTP/SSE');
            console.log('[MCP Launcher] Health checks:');
            console.log('  - http://localhost:3001/mcp/health');
            console.log('  - http://localhost:3002/mcp/health');
            console.log('  - http://localhost:3003/mcp/health');
            console.log('  - http://localhost:3004/mcp/health');
            console.log('\n[MCP Launcher] Press Ctrl+C to stop');
            // Handle shutdown
            const shutdown = () => __awaiter(this, void 0, void 0, function* () {
                console.log('\n[MCP Launcher] Shutting down servers...');
                for (const server of servers) {
                    yield server.stop();
                }
                process.exit(0);
            });
            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);
        }
        catch (error) {
            console.error('[MCP Launcher] Failed to start servers:', error);
            process.exit(1);
        }
    });
}
main();
