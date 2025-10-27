/**
 * MCP Server Registry
 * Tracks available MCP servers and their capabilities
 */

import { Redis } from 'ioredis';
import { McpClient } from './client';
import { Tool } from './types';

export interface ServerRegistration {
  name: string;
  version: string;
  tools: Tool[];
  capabilities: Record<string, unknown> | { tools?: { listChanged?: boolean } };
}

/**
 * MCP Registry for discovering and managing server connections
 */
export class McpRegistry {
  private redis: Redis;
  private clients: Map<string, McpClient> = new Map();
  private servers: Map<string, ServerRegistration> = new Map();

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Register a server and connect to it
   */
  async registerServer(serverName: string): Promise<void> {
    if (this.clients.has(serverName)) {
      console.log(`[Registry] Server ${serverName} already registered`);
      return;
    }

    const client = new McpClient(this.redis.duplicate(), serverName);
    
    try {
      // Connect and initialize
      await client.connect();
      const initResult = await client.initialize({
        name: 'registry-client',
        version: '1.0.0'
      });

      // Get tools list
      const toolsList = await client.listTools();

      // Store registration
      const registration: ServerRegistration = {
        name: initResult.serverInfo.name,
        version: initResult.serverInfo.version,
        tools: toolsList.tools,
        capabilities: initResult.capabilities
      };

      this.clients.set(serverName, client);
      this.servers.set(serverName, registration);

    } catch (error) {
      console.error(`[Registry] Failed to register server ${serverName}:`, error);
      throw error;
    }
  }

  /**
   * Unregister a server
   */
  async unregisterServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    
    if (client) {
      await client.disconnect();
      this.clients.delete(serverName);
      this.servers.delete(serverName);
    }
  }

  /**
   * Get client for a server
   */
  getClient(serverName: string): McpClient | undefined {
    return this.clients.get(serverName);
  }

  /**
   * Get server registration info
   */
  getServer(serverName: string): ServerRegistration | undefined {
    return this.servers.get(serverName);
  }

  /**
   * Get all registered servers
   */
  getAllServers(): ServerRegistration[] {
    return Array.from(this.servers.values());
  }

  /**
   * Find tool by name across all servers
   */
  findTool(toolName: string): { server: string; tool: Tool } | undefined {
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
  getAllTools(): Array<{ server: string; tool: Tool }> {
    const allTools: Array<{ server: string; tool: Tool }> = [];
    
    for (const [serverName, registration] of this.servers.entries()) {
      for (const tool of registration.tools) {
        allTools.push({ server: serverName, tool });
      }
    }
    
    return allTools;
  }

  /**
   * Call a tool (automatically finds the right server)
   */
  async callTool(
    toolName: string, 
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<any> {
    const found = this.findTool(toolName);
    
    if (!found) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    console.log(`[Registry] Calling tool: ${toolName} on server: ${found.server}, role: ${args.role}`);
    const client = this.clients.get(found.server);
    
    if (!client) {
      throw new Error(`Client not found for server: ${found.server}`);
    }

    const result = await client.callTool(toolName, args, meta);
    console.log(`[Registry] Tool ${toolName} returned, isError: ${result?.isError}`);
    return result;
  }

  /**
   * Disconnect all clients
   */
  async disconnectAll(): Promise<void> {
    console.log('[Registry] Disconnecting all clients');
    
    for (const [serverName, client] of this.clients.entries()) {
      try {
        await client.disconnect();
        console.log(`[Registry] Disconnected from ${serverName}`);
      } catch (error) {
        console.error(`[Registry] Error disconnecting from ${serverName}:`, error);
      }
    }
    
    this.clients.clear();
    this.servers.clear();
  }
}
