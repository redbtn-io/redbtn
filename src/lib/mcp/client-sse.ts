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

/**
 * Per-request auth-header provider. Invoked fresh on every outbound request
 * so short-lived tokens (e.g. a 5-minute identity JWT minted for a first-party
 * `*.redbtn.io` MCP connection's owner) never go stale between the one-time
 * startup registration and a long-running graph execution. The engine stays
 * provider-agnostic — the caller (worker / webapp) decides what to mint and
 * supplies this callback at registration time. Returned headers are merged
 * OVER the static `headers` so dynamic auth wins.
 */
export type AuthHeaderProvider = () => Record<string, string> | Promise<Record<string, string>>;

export class McpClientSSE {
  private serverUrl: string;
  private serverName: string;
  private sessionId: string;
  private requestId = 0;
  private extraHeaders: Record<string, string>;
  private getAuthHeaders?: AuthHeaderProvider;

  constructor(
    serverUrl: string,
    serverName: string,
    headers?: Record<string, string>,
    getAuthHeaders?: AuthHeaderProvider,
  ) {
    this.serverUrl = serverUrl;
    this.serverName = serverName;
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.extraHeaders = headers ?? {};
    this.getAuthHeaders = getAuthHeaders;
  }

  /**
   * Build the header set for an outbound request: static `extraHeaders` plus
   * a fresh invocation of the auth provider (if any). Auth headers override
   * static ones on key collision.
   */
  private async buildHeaders(base?: Record<string, string>): Promise<Record<string, string>> {
    const auth = this.getAuthHeaders ? await this.getAuthHeaders() : {};
    return { ...(base ?? {}), ...this.extraHeaders, ...auth };
  }

  /**
   * Connect to MCP server (just validates connection)
   */
  async connect(): Promise<void> {
    // Test connection with health check
    try {
      const response = await fetch(`${this.serverUrl}/health`, {
        headers: await this.buildHeaders(),
      });
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
   *
   * @param name Tool name
   * @param args Tool arguments
   * @param meta Optional metadata + credentials
   * @param signal Optional AbortSignal — passed through to the underlying
   *   fetch() so mid-step interrupt cancels the HTTP request immediately.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: {
      conversationId?: string;
      generationId?: string;
      messageId?: string;
      credentials?: {
        type: string;
        headers: Record<string, string>;
        providerId: string;
        connectionId: string;
        accountInfo?: { email?: string; name?: string; externalId?: string };
      };
    },
    signal?: AbortSignal
  ): Promise<CallToolResult> {
    return await this.sendRequest<CallToolResult>('tools/call', {
      name,
      arguments: args,
      _meta: meta,
    }, signal);
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
   *
   * `fetch` natively supports AbortSignal, so mid-step interrupt is wired
   * directly into the underlying request.
   */
  private async sendRequest<T>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
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
        headers: await this.buildHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(request),
        signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(`${result.error.message} (code: ${result.error.code})`);
      }

      return result.result as T;
    } catch (error: any) {
      // Re-throw AbortError as-is so callers can detect interrupt cleanly.
      if (error?.name === 'AbortError') {
        throw error;
      }
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
      headers: await this.buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(notification),
    });
  }
}
