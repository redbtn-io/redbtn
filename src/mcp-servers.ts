#!/usr/bin/env tsx
/**
 * MCP Servers Launcher - SSE Transport
 * Starts all MCP tool servers as HTTP/SSE endpoints.
 *
 * After Phase A of the native-tools restructure (see TOOL-HANDOFF.md §2):
 *   - system, rag, and context MCP servers were deleted; their tools live as
 *     native (in-process) tools in src/lib/tools/native/.
 *   - Only the web MCP server remains, pending Phase B's web pack which will
 *     port web_search/scrape_url to native and delete this launcher entirely.
 */

import { WebServerSSE } from './lib/mcp/servers/web-sse';

async function main() {
  console.log('[MCP Launcher] Starting MCP servers with SSE transport...');

  const servers: Array<{ start: () => Promise<void>; stop: () => Promise<void> }> = [];

  try {
    // Web Server (port 3001)
    const webServer = new WebServerSSE('web', '1.0.0', 3001);
    await webServer.start();
    servers.push(webServer);
    console.log('[MCP Launcher] ✓ Web server started on http://localhost:3001/mcp');

    console.log('\n[MCP Launcher] All servers started successfully');
    console.log('[MCP Launcher] Protocol: JSON-RPC 2.0 over HTTP/SSE');
    console.log('[MCP Launcher] Health checks:');
    console.log('  - http://localhost:3001/mcp/health');
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
