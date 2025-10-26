/**
 * MCP Client
 * Implements JSON-RPC 2.0 client over Redis transport
 */

import { Redis } from 'ioredis';
import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  InitializeParams,
  InitializeResult,
  ToolsListResult,
  ToolCallParams,
  CallToolResult,
} from './types';

export class McpClient {
  private redis: Redis;
  private subscriber: Redis;
  private serverName: string;
  private requestChannel: string;
  private responseChannel: string;
  private pendingRequests: Map<string | number, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = new Map();
  private requestId = 0;

  constructor(redis: Redis, serverName: string) {
    this.redis = redis;
    this.subscriber = redis.duplicate();
    this.serverName = serverName;
    this.requestChannel = `mcp:server:${serverName}:request`;
    this.responseChannel = `mcp:server:${serverName}:response`;
  }

  /**
   * Connect to MCP server
   */
  async connect(): Promise<void> {
    console.log(`[MCP Client] Connecting to ${this.serverName}`);
    
    // Subscribe to response channel
    await this.subscriber.subscribe(this.responseChannel);
    
    // Listen for responses
    this.subscriber.on('message', (channel, message) => {
      if (channel === this.responseChannel) {
        this.handleResponse(message);
      }
    });
    
    console.log(`[MCP Client] Connected to ${this.serverName}`);
  }

  /**
   * Disconnect from MCP server
   */
  async disconnect(): Promise<void> {
    console.log(`[MCP Client] Disconnecting from ${this.serverName}`);
    await this.subscriber.unsubscribe(this.responseChannel);
    await this.subscriber.quit();
  }

  /**
   * Initialize connection with server
   */
  async initialize(clientInfo: { name: string; version: string }): Promise<InitializeResult> {
    const params: InitializeParams = {
      protocolVersion: '2025-06-18',
      capabilities: {
        elicitation: {},
      },
      clientInfo,
    };

    const result = await this.sendRequest<InitializeResult>('initialize', params as unknown as Record<string, unknown>);
    
    // Send initialized notification
    await this.sendNotification('notifications/initialized');
    
    return result;
  }

  /**
   * List available tools
   */
  async listTools(): Promise<ToolsListResult> {
    return await this.sendRequest<ToolsListResult>('tools/list');
  }

  /**
   * Call a tool
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const params: ToolCallParams = {
      name,
      arguments: args,
    };
    
    return await this.sendRequest<CallToolResult>('tools/call', params as unknown as Record<string, unknown>);
  }

  /**
   * Send JSON-RPC request
   */
  private async sendRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId;
    
    const request: JsonRpcRequest = {
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
  }

  /**
   * Send JSON-RPC notification (no response expected)
   */
  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    
    await this.redis.publish(this.requestChannel, JSON.stringify(notification));
  }

  /**
   * Handle incoming response
   */
  private handleResponse(message: string): void {
    try {
      const response = JSON.parse(message) as JsonRpcResponse | JsonRpcNotification;
      
      // Check if it's a notification
      if (!('id' in response)) {
        this.handleNotification(response as JsonRpcNotification);
        return;
      }

      // Handle response
      const { id, result, error } = response as JsonRpcResponse;
      const pending = this.pendingRequests.get(id);
      
      if (!pending) {
        console.warn(`[MCP Client] Received response for unknown request: ${id}`);
        return;
      }
      
      this.pendingRequests.delete(id);
      
      if (error) {
        pending.reject(new Error(`${error.message} (code: ${error.code})`));
      } else {
        pending.resolve(result);
      }

    } catch (error) {
      console.error(`[MCP Client] Error handling response:`, error);
    }
  }

  /**
   * Handle incoming notification
   */
  private handleNotification(notification: JsonRpcNotification): void {
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
