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

export interface McpClientSSEOptions {
  /** Static HTTP headers sent on every request (e.g. a service key). */
  headers?: Record<string, string>;
  /**
   * Path appended to `serverUrl` for JSON-RPC POSTs. Defaults to `/message`
   * (the bundled red MCP server convention). Set to `''` for gateways whose
   * JSON-RPC endpoint IS the base URL (e.g. the shared mcp-gateway namespaces
   * at https://mcp.redbtn.io/<provider>/<service>).
   */
  messagePath?: string;
}

export class McpClientSSE {
  private serverUrl: string;
  private serverName: string;
  private sessionId: string;
  private requestId = 0;
  private extraHeaders: Record<string, string>;
  private messagePath: string;

  constructor(
    serverUrl: string,
    serverName: string,
    headersOrOptions?: Record<string, string> | McpClientSSEOptions,
  ) {
    this.serverUrl = serverUrl;
    this.serverName = serverName;
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    // Back-compat: a plain object of headers is still accepted.
    if (headersOrOptions && ('headers' in headersOrOptions || 'messagePath' in headersOrOptions)) {
      const opts = headersOrOptions as McpClientSSEOptions;
      this.extraHeaders = opts.headers ?? {};
      this.messagePath = opts.messagePath ?? '/message';
    } else {
      this.extraHeaders = (headersOrOptions as Record<string, string>) ?? {};
      this.messagePath = '/message';
    }
  }

  /** Resolve the JSON-RPC POST endpoint (base URL + configured message path). */
  private endpoint(): string {
    return `${this.serverUrl}${this.messagePath}`;
  }

  /**
   * Extract per-call HTTP headers from a tool-call meta object. Gateways that
   * authenticate at the HTTP layer (rather than reading body `_meta`) need the
   * end-user bearer promoted onto the request headers — `_meta.credentials.headers`
   * carries it (e.g. { Authorization: 'Bearer <token>' }).
   */
  private perCallHeaders(params?: Record<string, unknown>): Record<string, string> {
    const meta = (params as any)?._meta;
    const credHeaders = meta?.credentials?.headers;
    if (credHeaders && typeof credHeaders === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(credHeaders)) {
        if (typeof v === 'string' && v) out[k] = v;
      }
      return out;
    }
    return {};
  }

  /**
   * Connect to MCP server (just validates connection)
   */
  async connect(): Promise<void> {
    // Test connection with health check
    try {
      const response = await fetch(`${this.serverUrl}/health`, {
        headers: { ...this.extraHeaders },
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
      const response = await fetch(this.endpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.extraHeaders,
          // Promote per-call credential headers (e.g. an end-user bearer from
          // _meta.credentials.headers) onto the HTTP request so gateways that
          // gate on the Authorization header authorize as the END USER.
          ...this.perCallHeaders(params),
        },
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

    await fetch(this.endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.extraHeaders,
        ...this.perCallHeaders(params),
      },
      body: JSON.stringify(notification),
    });
  }
}
