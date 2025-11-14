#!/usr/bin/env tsx
/**
 * MCP Servers Launcher - SSE Transport
 * Starts all MCP tool servers as HTTP/SSE endpoints
 */

import { WebServerSSE } from './lib/mcp/servers/web-sse';
import { SystemServerSSE } from './lib/mcp/servers/system-sse';
import { RagServerSSE } from './lib/mcp/servers/rag-sse';
import { ContextServerSSE } from './lib/mcp/servers/context-sse';

async function main() {
  console.log('[MCP Launcher] Starting MCP servers with SSE transport...');

  const servers: Array<{ start: () => Promise<void>; stop: () => Promise<void> }> = [];

  try {
    // Web Server (port 3001)
    const webServer = new WebServerSSE('web', '1.0.0', 3001);
    await webServer.start();
    servers.push(webServer);
    console.log('[MCP Launcher] ✓ Web server started on http://localhost:3001/mcp');

    // System Server (port 3002)
    const systemServer = new SystemServerSSE('system', '1.0.0', 3002, {
      allowedCommands: [
        'ls', 'cat', 'pwd', 'echo', 'date', 'whoami',
        'find', 'grep', 'head', 'tail', 'wc', 'df', 'du',
        'git', 'npm', 'node', 'python'
      ],
      workingDirectory: process.cwd()
    });
    await systemServer.start();
    servers.push(systemServer);
    console.log('[MCP Launcher] ✓ System server started on http://localhost:3002/mcp');

    // RAG Server (port 3003)
    const ragServer = new RagServerSSE('rag', '1.0.0', 3003);
    await ragServer.start();
    servers.push(ragServer);
    console.log('[MCP Launcher] ✓ RAG server started on http://localhost:3003/mcp');

    // Context Server (port 3004)
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const contextServer = new ContextServerSSE('context', '1.0.0', 3004, redisUrl);
    await contextServer.start();
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
    const shutdown = async () => {
      console.log('\n[MCP Launcher] Shutting down servers...');
      
      for (const server of servers) {
        await server.stop();
      }
      
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    console.error('[MCP Launcher] Failed to start servers:', error);
    process.exit(1);
  }
}

main();

