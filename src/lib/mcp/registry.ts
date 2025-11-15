/**
 * MCP Server Registry
 * Tracks available MCP servers and their capabilities
 */

import { McpClientSSE } from './client-sse';
import { Tool } from './types';
import { MessageQueue } from '../memory/queue';

export interface ServerRegistration {
  name: string;
  version: string;
  tools: Tool[];
  capabilities: Record<string, unknown> | { tools?: { listChanged?: boolean } };
  url: string;
}

export interface ServerConfig {
  name: string;
  url: string;  // e.g., 'http://localhost:3001/mcp'
}

/**
 * MCP Registry for discovering and managing server connections
 */
export class McpRegistry {
  private clients: Map<string, McpClientSSE> = new Map();
  private servers: Map<string, ServerRegistration> = new Map();
  private messageQueue?: MessageQueue;

  constructor(messageQueue?: MessageQueue) {
    // messageQueue is optional - if provided, enables tool event publishing
    this.messageQueue = messageQueue;
  }

  /**
   * Register a server and connect to it
   */
  async registerServer(config: ServerConfig): Promise<void> {
    const { name, url } = config;
    
    if (this.clients.has(name)) {
      console.log(`[Registry] Server ${name} already registered`);
      return;
    }

    const client = new McpClientSSE(url, name);
    
    try {
      // Connect and initialize
      await client.connect();
      const initResult = await client.initialize({
        name: 'red-ai-client',
        version: '1.0.0'
      });

      // Get tools list
      const toolsList = await client.listTools();

      // Store registration
      const registration: ServerRegistration = {
        name: initResult.serverInfo.name,
        version: initResult.serverInfo.version,
        tools: toolsList.tools,
        capabilities: initResult.capabilities,
        url
      };

      this.clients.set(name, client);
      this.servers.set(name, registration);

      console.log(`[Registry] Registered ${name} with ${toolsList.tools.length} tools`);

    } catch (error) {
      console.error(`[Registry] Failed to register server ${name}:`, error);
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
  getClient(serverName: string): McpClientSSE | undefined {
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
   * Get all server names
   */
  getAllServerNames(): string[] {
    return Array.from(this.servers.keys());
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
   * Wraps tool execution with event publishing for frontend display
   * (skips event publishing for infrastructure tools like context)
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

    // Skip event publishing for infrastructure tools (context, rag storage)
    const isInfrastructureTool = found.server === 'context' || 
      (found.server === 'rag' && ['add_document', 'delete_documents'].includes(toolName));
    
    // Publish tool start event if messageId is provided and not infrastructure
    const toolId = `${toolName}_${Date.now()}`;
    if (meta?.messageId && this.messageQueue && !isInfrastructureTool) {
      await this.messageQueue.publishToolEvent(meta.messageId, {
        type: 'tool_start',
        toolId,
        toolType: toolName,
        toolName,
        timestamp: Date.now(),
        metadata: meta
      });
    }

    const startTime = Date.now();
    try {
      const result = await client.callTool(toolName, args, meta);
      const duration = Date.now() - startTime;
      
      console.log(`[Registry] Tool ${toolName} returned in ${duration}ms, isError: ${result?.isError}`);
      
      // Publish tool complete event
      if (meta?.messageId && this.messageQueue && !isInfrastructureTool) {
        await this.messageQueue.publishToolEvent(meta.messageId, {
          type: 'tool_complete',
          toolId,
          toolType: toolName,
          toolName,
          timestamp: Date.now(),
          result: result,
          metadata: { ...meta, duration }
        });
      }
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Publish tool error event
      if (meta?.messageId && this.messageQueue && !isInfrastructureTool) {
        await this.messageQueue.publishToolEvent(meta.messageId, {
          type: 'tool_error',
          toolId,
          toolType: toolName,
          toolName,
          timestamp: Date.now(),
          error: error instanceof Error ? error.message : String(error),
          metadata: { ...meta, duration }
        });
      }
      
      throw error;
    }
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
