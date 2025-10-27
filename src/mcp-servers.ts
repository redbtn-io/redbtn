#!/usr/bin/env tsx
/**
 * MCP Servers Launcher
 * Starts all MCP tool servers as separate processes
 * Implements JSON-RPC 2.0 over Redis transport
 */

import Redis from 'ioredis';
import { WebServer, SystemServer, RagServer, ContextServer } from './lib/mcp';
import { McpServer } from './lib/mcp/server';

// Create Redis connections for each server
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

async function main() {
  console.log('[MCP Launcher] Starting MCP servers...');
  console.log(`[MCP Launcher] Redis: ${redisUrl}`);

  const servers: McpServer[] = [];

  try {
    // Web Server (combines search + scraping)
    const webRedis = new Redis(redisUrl);
    const webServer = new WebServer(webRedis);
    await webServer.start();
    servers.push(webServer);

    // System Server (command execution)
    const systemRedis = new Redis(redisUrl);
    const systemServer = new SystemServer(systemRedis, {
      allowedCommands: [
        'ls', 'cat', 'pwd', 'echo', 'date', 'whoami',
        'find', 'grep', 'head', 'tail', 'wc', 'df', 'du',
        'git', 'npm', 'node'
      ],
      workingDirectory: process.cwd()
    });
    await systemServer.start();
    servers.push(systemServer);

    // RAG Server (vector database operations)
    const ragRedis = new Redis(redisUrl);
    const ragServer = new RagServer(ragRedis);
    await ragServer.start();
    servers.push(ragServer);

    // Context Server (conversation context and history)
    const contextRedis = new Redis(redisUrl);
    const contextServer = new ContextServer(contextRedis, redisUrl);
    await contextServer.start();
    servers.push(contextServer);

    console.log('[MCP Launcher] All servers started successfully');
    console.log('[MCP Launcher] Protocol: JSON-RPC 2.0 over Redis pub/sub');
    console.log('[MCP Launcher] Press Ctrl+C to stop');

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log('\n[MCP Launcher] Shutting down servers...');
      
      for (const server of servers) {
        await server.stop();
      }
      
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n[MCP Launcher] Shutting down servers...');
      
      for (const server of servers) {
        await server.stop();
      }
      
      process.exit(0);
    });

  } catch (error) {
    console.error('[MCP Launcher] Failed to start servers:', error);
    process.exit(1);
  }
}

main();
