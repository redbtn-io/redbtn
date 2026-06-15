/**
 * MCP Server Registry
 * Tracks available MCP servers and their capabilities
 */

import { McpClientSSE } from './client-sse';
import { Tool } from './types';

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
  /** Optional HTTP headers forwarded on every request to this server (e.g. Authorization). */
  headers?: Record<string, string>;
}

/**
 * MCP Registry for discovering and managing server connections
 */
export class McpRegistry {
  private clients: Map<string, McpClientSSE> = new Map();
  private servers: Map<string, ServerRegistration> = new Map();

  constructor(
    // messageQueue parameter was removed in v0.0.51-alpha. McpRegistry no longer
    // publishes to the legacy message:stream:* Redis channel. Tool events are now
    // published via RunPublisher in the universalNode toolExecutor.
    // The parameter is accepted but ignored to avoid breaking call sites in
    // Red constructor (which still passes red.messageQueue for now).
    _messageQueue?: unknown
  ) {}

  /**
   * Register a server and connect to it
   */
  async registerServer(config: ServerConfig): Promise<void> {
    const { name, url, headers } = config;

    if (this.clients.has(name)) {
      console.log(`[Registry] Server ${name} already registered`);
      return;
    }

    const client = new McpClientSSE(url, name, headers);

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
   * Register a server WITHOUT the connect/initialize/listTools handshake.
   *
   * Use this for gateways that require per-request authentication (so the
   * unauthenticated `initialize`/`tools/list` handshake would 401), but expose
   * their tool roster via an unauthenticated `GET {url}/health` endpoint and
   * accept credentials per-call via `_meta.credentials.headers`. Credentials
   * are supplied at call time (templated per-run from state), NOT here.
   *
   * Tool schemas are best-effort: `/health` only advertises tool names, so we
   * register permissive object schemas. The neuron tool-resolver tolerates
   * this (the runtime tool call validates server-side).
   *
   * @param config.tools Optional explicit tool roster. When omitted we probe
   *   `{url}/health` for a `tools: string[]` list.
   */
  async registerStaticServer(config: ServerConfig & { tools?: string[]; messagePath?: string }): Promise<void> {
    const { name, url, headers } = config;

    if (this.clients.has(name)) {
      console.log(`[Registry] Static server ${name} already registered`);
      return;
    }

    let toolNames: string[] = config.tools ?? [];
    if (toolNames.length === 0) {
      try {
        const res = await fetch(`${url}/health`, { headers: { ...(headers ?? {}) } });
        if (res.ok) {
          const body: any = await res.json();
          if (Array.isArray(body?.tools)) {
            toolNames = body.tools.filter((t: unknown) => typeof t === 'string');
          }
        } else {
          console.warn(`[Registry] Static server ${name} health probe returned ${res.status}`);
        }
      } catch (err) {
        console.warn(`[Registry] Static server ${name} health probe failed:`, err);
      }
    }

    if (toolNames.length === 0) {
      throw new Error(`[Registry] registerStaticServer: no tools discovered for ${name} at ${url}`);
    }

    const tools: Tool[] = toolNames.map((toolName) => ({
      name: toolName,
      description: `MCP tool ${toolName} on ${name}`,
      inputSchema: { type: 'object', properties: {} },
    }));

    const client = new McpClientSSE(url, name, {
      headers,
      // Gateway namespaces (mcp.redbtn.io/<provider>/<service>) expose their
      // JSON-RPC endpoint at the base URL, not at /message. Default '' here;
      // callers can override for servers that use the /message convention.
      messagePath: config.messagePath ?? '',
    });
    const registration: ServerRegistration = {
      name,
      version: '1.0.0',
      tools,
      capabilities: { tools: { listChanged: false } },
      url,
    };

    this.clients.set(name, client);
    this.servers.set(name, registration);
    console.log(`[Registry] Statically registered ${name} with ${tools.length} tools (no handshake)`);
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
   *
   * @param signal Optional AbortSignal — passed through to the underlying
   *   client.callTool so mid-step interrupt cancels the in-flight HTTP/SSE
   *   request immediately. Required for the run-level abort path.
   */
  async callTool(
    toolName: string,
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

    const startTime = Date.now();
    try {
      const result = await client.callTool(toolName, args, meta, signal);
      const duration = Date.now() - startTime;

      console.log(`[Registry] Tool ${toolName} returned in ${duration}ms, isError: ${result?.isError}`);
      return result;
    } catch (error) {
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
