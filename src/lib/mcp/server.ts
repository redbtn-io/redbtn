/**
 * MCP Server Base Class
 * Implements JSON-RPC 2.0 over Redis transport
 */

import { Redis } from 'ioredis';
import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  ServerInfo,
  ServerCapabilities,
  Tool,
  CallToolResult,
  InitializeParams,
  InitializeResult,
  ToolsListResult,
  ToolCallParams,
} from './types';

export abstract class McpServer {
  protected redis: Redis;
  protected publishRedis: Redis; // Separate connection for publishing
  protected serverInfo: ServerInfo;
  protected capabilities: ServerCapabilities = {};
  protected tools: Map<string, Tool> = new Map();
  private requestChannel: string;
  private responseChannel: string;
  private running = false;

  constructor(redis: Redis, name: string, version: string) {
    this.redis = redis;
    // Create a separate Redis connection for publishing
    this.publishRedis = redis.duplicate();
    this.serverInfo = { name, version };
    this.requestChannel = `mcp:server:${name}:request`;
    this.responseChannel = `mcp:server:${name}:response`;
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    console.log(`[MCP Server] Starting ${this.serverInfo.name} v${this.serverInfo.version}`);
    
    // Call setup to define tools and capabilities
    await this.setup();
    
    console.log(`[MCP Server] ${this.serverInfo.name} registered ${this.tools.size} tools`);
    
    // Subscribe to request channel
    await this.redis.subscribe(this.requestChannel);
    
    this.running = true;
    
    // Listen for messages
    this.redis.on('message', async (channel, message) => {
      if (channel === this.requestChannel) {
        await this.handleMessage(message);
      }
    });
    
    console.log(`[MCP Server] ${this.serverInfo.name} listening on ${this.requestChannel}`);
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    console.log(`[MCP Server] Stopping ${this.serverInfo.name}`);
    this.running = false;
    await this.redis.unsubscribe(this.requestChannel);
    await this.publishRedis.quit();
    console.log(`[MCP Server] ${this.serverInfo.name} stopped`);
  }

  /**
   * Setup method - subclasses override to define tools
   */
  protected abstract setup(): Promise<void>;

  /**
   * Execute tool - subclasses override to implement tool logic
   */
  protected abstract executeTool(
    name: string,
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult>;

  /**
   * Define a tool
   */
  protected defineTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Handle incoming JSON-RPC message
   */
  private async handleMessage(message: string): Promise<void> {
    try {
      const request = JSON.parse(message) as JsonRpcRequest | JsonRpcNotification;
      
      // Check if it's a notification (no id field)
      if (!('id' in request)) {
        // Handle notification (no response needed)
        await this.handleNotification(request as JsonRpcNotification);
        return;
      }

      // Handle request and send response
      const response = await this.handleRequest(request as JsonRpcRequest);
      await this.sendResponse(response);

    } catch (error) {
      console.error(`[MCP Server] ${this.serverInfo.name} error handling message:`, error);
    }
  }

  /**
   * Handle JSON-RPC request
   */
  private async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { id, method, params } = request;

    try {
      let result: unknown;

      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(params as unknown as InitializeParams);
          break;

        case 'tools/list':
          result = await this.handleToolsList();
          break;

        case 'tools/call':
          result = await this.handleToolCall(params as unknown as ToolCallParams);
          break;

        default:
          throw {
            code: -32601,
            message: `Method not found: ${method}`,
          };
      }

      return {
        jsonrpc: '2.0',
        id,
        result,
      };

    } catch (error: any) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: error.code || -32603,
          message: error.message || 'Internal error',
          data: error.data,
        },
      };
    }
  }

  /**
   * Handle notification (no response)
   */
  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    const { method } = notification;
    
    switch (method) {
      case 'notifications/initialized':
        console.log(`[MCP Server] ${this.serverInfo.name} client initialized`);
        break;
      
      default:
        console.log(`[MCP Server] ${this.serverInfo.name} unknown notification: ${method}`);
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(params: InitializeParams): Promise<InitializeResult> {
    console.log(`[MCP Server] ${this.serverInfo.name} initializing with client: ${params.clientInfo.name}`);
    
    return {
      protocolVersion: '2025-06-18',
      capabilities: this.capabilities,
      serverInfo: this.serverInfo,
    };
  }

  /**
   * Handle tools/list request
   */
  private async handleToolsList(): Promise<ToolsListResult> {
    return {
      tools: Array.from(this.tools.values()),
    };
  }

  /**
   * Handle tools/call request
   */
  private async handleToolCall(params: ToolCallParams): Promise<CallToolResult> {
    const { name, arguments: args, _meta } = params;

    if (!this.tools.has(name)) {
      throw {
        code: -32602,
        message: `Tool not found: ${name}`,
      };
    }

    console.log(`[MCP Server] ${this.serverInfo.name} executing tool: ${name}`);
    
    return await this.executeTool(name, args, _meta);
  }

  /**
   * Send JSON-RPC response
   */
  private async sendResponse(response: JsonRpcResponse): Promise<void> {
    await this.publishRedis.publish(this.responseChannel, JSON.stringify(response));
  }

  /**
   * Send JSON-RPC notification
   */
  protected async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    
    await this.publishRedis.publish(this.responseChannel, JSON.stringify(notification));
  }
}
