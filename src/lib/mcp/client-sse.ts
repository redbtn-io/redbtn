/**
 * MCP Client - SSE Transport
 * Connects to MCP servers over HTTP/SSE
 */

import {
  InitializeResult,
  ToolsListResult,
  CallToolResult,
  Resource,
  ResourceContents,
} from './types';

export class McpClientSSE {
  private serverUrl: string;
  private serverName: string;
  private sessionId: string;
  private requestId = 0;

  constructor(serverUrl: string, serverName: string) {
    this.serverUrl = serverUrl;
    this.serverName = serverName;
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Connect to MCP server (just validates connection)
   */
  async connect(): Promise<void> {
    // Test connection with health check
    try {
      const response = await fetch(`${this.serverUrl}/health`);
      if (!response.ok) {
        throw new Error(`Server health check failed: ${response.status}`);
      }
      console.log(`[MCP Client] Connected to ${this.serverName} at ${this.serverUrl}`);
    } catch (error) {
      throw new Error(`Failed to connect to ${this.serverName}: ${error}`);
    }
  }

  /**
   * Disconnect from MCP server
   */
  async disconnect(): Promise<void> {
    // Nothing to do for HTTP transport
  }

  /**
   * Initialize connection with server
   */
  async initialize(clientInfo: { name: string; version: string }): Promise<InitializeResult> {
    const result = await this.sendRequest<InitializeResult>('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        elicitation: {},
      },
      clientInfo,
    });

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
  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    return await this.sendRequest<CallToolResult>('tools/call', {
      name,
      arguments: args,
      _meta: meta,
    });
  }

  /**
   * List available resources
   */
  async listResources(): Promise<{ resources: Resource[] }> {
    return await this.sendRequest('resources/list');
  }

  /**
   * Read a resource
   */
  async readResource(params: { uri: string }): Promise<{ contents: ResourceContents[] }> {
    return await this.sendRequest('resources/read', params);
  }

  /**
   * Send JSON-RPC request
   */
  private async sendRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId;

    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    try {
      const response = await fetch(`${this.serverUrl}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(`${result.error.message} (code: ${result.error.code})`);
      }

      return result.result as T;
    } catch (error) {
      throw new Error(`Request to ${this.serverName} failed: ${error}`);
    }
  }

  /**
   * Send JSON-RPC notification (no response expected)
   */
  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    await fetch(`${this.serverUrl}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(notification),
    });
  }
}
