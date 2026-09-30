/**
 * MCP Server Registry
 * Tracks available MCP servers and their capabilities.
 *
 * Every server belongs to exactly one ACCOUNT (`ownerUserId`) — a user's MCP
 * connection is that user's, and a run can only reach the servers of the
 * account it executes as ({@link McpToolScope}). There is no "global" user
 * connection: adding an MCP server to an account never makes its tools
 * available to anyone else on the platform.
 *
 * Servers are keyed by (ownerUserId, name), so two accounts can each have a
 * connection called e.g. "RedRun" and both load, neither shadowing the other.
 *
 * The only exception is an explicitly PLATFORM-level server (`platform: true`)
 * — one configured by the platform itself, not by a user account. Those are
 * visible to every run. None are registered today; the flag exists so such a
 * server has to be declared deliberately rather than by omitting an owner.
 */

import { McpClientSSE } from './client-sse';
import { Tool } from './types';

export interface ServerRegistration {
  /** Server-reported name (handshake) or the connection name (static). */
  name: string;
  /** Connection name the server was registered under. */
  connectionName: string;
  version: string;
  tools: Tool[];
  capabilities: Record<string, unknown> | { tools?: { listChanged?: boolean } };
  url: string;
  /** Owning account. Undefined only for `platform` servers. */
  ownerUserId?: string;
  /** True for platform-level servers (visible to every run). */
  platform?: boolean;
}

/**
 * The account a lookup is made for — the account the run EXECUTES AS
 * (see lib/mcp/run-scope). An unscoped lookup sees platform servers only.
 */
export interface McpToolScope {
  userId?: string;
}

export interface ServerConfig {
  /** Connection name (unique per owner). */
  name: string;
  url: string;  // e.g., 'http://localhost:3001/mcp'
  /** Optional HTTP headers forwarded on every request to this server (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Account that owns the connection. Required unless `platform` is true. */
  ownerUserId?: string;
  /** Platform-level server configured by the platform, not by a user account. */
  platform?: boolean;
}

/** A tool match. `server` is the connection name. */
export interface FoundTool {
  server: string;
  tool: Tool;
  ownerUserId?: string;
}

const PLATFORM = '\u0000platform';

function ownerKey(ownerUserId: string | undefined, platform?: boolean): string {
  return platform ? PLATFORM : String(ownerUserId);
}

function serverKey(owner: string, name: string): string {
  return `${owner}\u0000${name}`;
}

/**
 * MCP Registry for discovering and managing server connections
 */
export class McpRegistry {
  /** Keyed by serverKey(owner, name). */
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
   * Resolve the storage key for a registration, failing closed when the
   * caller forgot to say who owns it: an unowned server would otherwise be
   * reachable by nobody (or, historically, by everybody).
   */
  private keyFor(config: ServerConfig): { key: string; owner: string } {
    if (!config.platform && !config.ownerUserId) {
      throw new Error(
        `[Registry] MCP server '${config.name}' has no ownerUserId — every MCP connection belongs to an account ` +
        `(pass platform: true only for a platform-configured server)`,
      );
    }
    const owner = ownerKey(config.ownerUserId, config.platform);
    return { key: serverKey(owner, config.name), owner };
  }

  private ownership(config: ServerConfig): Pick<ServerRegistration, 'ownerUserId' | 'platform'> {
    return config.platform ? { platform: true } : { ownerUserId: String(config.ownerUserId) };
  }

  /**
   * Register a server and connect to it
   */
  async registerServer(config: ServerConfig): Promise<void> {
    const { name, url, headers } = config;
    const { key } = this.keyFor(config);

    if (this.clients.has(key)) {
      console.log(`[Registry] Server ${name} already registered for this account`);
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
        connectionName: name,
        version: initResult.serverInfo.version,
        tools: toolsList.tools,
        capabilities: initResult.capabilities,
        url,
        ...this.ownership(config),
      };

      this.clients.set(key, client);
      this.servers.set(key, registration);

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
    const { key } = this.keyFor(config);

    if (this.clients.has(key)) {
      console.log(`[Registry] Static server ${name} already registered for this account`);
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
      connectionName: name,
      version: '1.0.0',
      tools,
      capabilities: { tools: { listChanged: false } },
      url,
      ...this.ownership(config),
    };

    this.clients.set(key, client);
    this.servers.set(key, registration);
    console.log(`[Registry] Statically registered ${name} with ${tools.length} tools (no handshake)`);
  }

  /**
   * Unregister one account's server (or a platform server with
   * `{ platform: true }`).
   */
  async unregisterServer(serverName: string, ownerUserId?: string, opts?: { platform?: boolean }): Promise<void> {
    if (!ownerUserId && !opts?.platform) return;
    const key = serverKey(ownerKey(ownerUserId, opts?.platform), serverName);
    const client = this.clients.get(key);

    if (client) {
      await client.disconnect();
      this.clients.delete(key);
      this.servers.delete(key);
    }
  }

  /** Get the client for one account's server. */
  getClient(serverName: string, ownerUserId?: string, opts?: { platform?: boolean }): McpClientSSE | undefined {
    if (!ownerUserId && !opts?.platform) return undefined;
    return this.clients.get(serverKey(ownerKey(ownerUserId, opts?.platform), serverName));
  }

  /** Get one account's server registration. */
  getServer(serverName: string, ownerUserId?: string, opts?: { platform?: boolean }): ServerRegistration | undefined {
    if (!ownerUserId && !opts?.platform) return undefined;
    return this.servers.get(serverKey(ownerKey(ownerUserId, opts?.platform), serverName));
  }

  /**
   * Whether a registration is visible to a scope: platform servers always,
   * account servers only to that account.
   */
  private isVisible(registration: ServerRegistration, scope?: McpToolScope): boolean {
    if (registration.platform) return true;
    return !!scope?.userId && String(scope.userId) === registration.ownerUserId;
  }

  /** Registrations visible to `scope` (the account's own first, then platform). */
  private *visible(scope?: McpToolScope): Iterable<[string, ServerRegistration]> {
    const platform: Array<[string, ServerRegistration]> = [];
    for (const entry of this.servers.entries()) {
      if (!this.isVisible(entry[1], scope)) continue;
      if (entry[1].platform) platform.push(entry);
      else yield entry;
    }
    yield* platform;
  }

  /** Every registration (admin/diagnostic view — do not expose to runs). */
  getAllServers(): ServerRegistration[] {
    return Array.from(this.servers.values());
  }

  /** Connection names visible to `scope`. */
  getAllServerNames(scope?: McpToolScope): string[] {
    return Array.from(this.visible(scope), ([, r]) => r.connectionName);
  }

  /**
   * Find a tool among the servers visible to `scope`: the executing account's
   * own connections, then platform servers. Other accounts' connections are
   * never searched.
   */
  findTool(toolName: string, scope?: McpToolScope): FoundTool | undefined {
    for (const [, registration] of this.visible(scope)) {
      const tool = registration.tools.find(t => t.name === toolName);
      if (tool) {
        return {
          server: registration.connectionName,
          tool,
          ...(registration.ownerUserId ? { ownerUserId: registration.ownerUserId } : {}),
        };
      }
    }
    return undefined;
  }

  /** All tools visible to `scope`. */
  getAllTools(scope?: McpToolScope): Array<{ server: string; tool: Tool }> {
    const allTools: Array<{ server: string; tool: Tool }> = [];
    for (const [, registration] of this.visible(scope)) {
      for (const tool of registration.tools) {
        allTools.push({ server: registration.connectionName, tool });
      }
    }
    return allTools;
  }

  /**
   * Call a tool on a server visible to `scope`.
   *
   * @param signal Optional AbortSignal — passed through to the underlying
   *   client.callTool so mid-step interrupt cancels the in-flight HTTP/SSE
   *   request immediately. Required for the run-level abort path.
   * @param scope The account the run executes as. Only that account's
   *   connections (plus platform servers) are searched.
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
    signal?: AbortSignal,
    scope?: McpToolScope
  ): Promise<any> {
    let foundKey: string | undefined;
    for (const [key, registration] of this.visible(scope)) {
      if (registration.tools.some(t => t.name === toolName)) {
        foundKey = key;
        break;
      }
    }

    if (!foundKey) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const registration = this.servers.get(foundKey)!;
    console.log(`[Registry] Calling tool: ${toolName} on server: ${registration.connectionName}, role: ${args.role}`);
    const client = this.clients.get(foundKey);

    if (!client) {
      throw new Error(`Client not found for server: ${registration.connectionName}`);
    }

    const startTime = Date.now();
    const result = await client.callTool(toolName, args, meta, signal);
    const duration = Date.now() - startTime;

    console.log(`[Registry] Tool ${toolName} returned in ${duration}ms, isError: ${result?.isError}`);
    return result;
  }

  /**
   * Disconnect all clients
   */
  async disconnectAll(): Promise<void> {
    console.log('[Registry] Disconnecting all clients');

    for (const [key, client] of this.clients.entries()) {
      try {
        await client.disconnect();
        console.log(`[Registry] Disconnected from ${this.servers.get(key)?.connectionName ?? key}`);
      } catch (error) {
        console.error(`[Registry] Error disconnecting:`, error);
      }
    }

    this.clients.clear();
    this.servers.clear();
  }
}
