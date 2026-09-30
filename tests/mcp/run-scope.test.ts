/**
 * Run-scoped MCP client: the neuron tool loop reaches MCP through the run
 * context's `mcpClient`, bound to the account the run EXECUTES AS. Exercises
 * the real path — tool-resolver -> run mcpClient -> McpRegistry ->
 * McpClientSSE — with tools referenced by bare name (`{ name, source:'mcp' }`,
 * how the Become AI graph does it) and a per-call end-user bearer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { createRunMcpClient, resolveRunMcpScope } from '../../src/lib/mcp/run-scope';
import { resolveTools } from '../../src/lib/tools/tool-resolver';

const A = 'account-a';
const B = 'account-b';
const SYSTEM = '000000000000000000000001';

describe('run-scoped MCP client', () => {
  let requests: Array<{ url: string; headers: Record<string, string> }>;

  beforeEach(() => {
    requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url: String(url), headers: { ...(init?.headers ?? {}) } });
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: body?.id, result: { content: [{ type: 'text', text: JSON.stringify({ url: String(url) }) }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function registry() {
    const reg = new McpRegistry();
    // Both accounts own a connection with the same name and tool.
    await reg.registerStaticServer({ name: 'Discord', url: 'https://gw.example/discord-a', tools: ['discord_messages_send'], messagePath: '', ownerUserId: A });
    await reg.registerStaticServer({ name: 'Discord', url: 'https://gw.example/discord-b', tools: ['discord_messages_send'], messagePath: '', ownerUserId: B });
    await reg.registerStaticServer({ name: 'Become', url: 'https://gw.example/become/data', tools: ['become_get_progress'], messagePath: '', ownerUserId: A });
    return reg;
  }

  function stateFor(reg: McpRegistry, runOptions: { userId?: string; connectionIdentityUserId?: string }) {
    return {
      data: {},
      mcpClient: createRunMcpClient(
        (name, args, meta, signal, scope) => reg.callTool(name, args, meta as any, signal, scope),
        resolveRunMcpScope(runOptions),
      ),
    } as Record<string, unknown>;
  }

  async function call(state: Record<string, unknown>, toolName: string, bearer?: string) {
    const [tool] = await resolveTools([{ name: toolName, source: 'mcp' } as any], state);
    return tool.invoke({}, {
      state, runId: 'r', toolId: 't', abortSignal: null,
      credentials: bearer ? { type: 'bearer', headers: { Authorization: bearer } } : undefined,
    });
  }

  it('scopes to the executing user (the delegated caller when present)', () => {
    expect(resolveRunMcpScope({ userId: A })).toEqual({ userId: A });
    expect(resolveRunMcpScope({ userId: A, connectionIdentityUserId: B })).toEqual({ userId: B });
    expect(resolveRunMcpScope(undefined)).toEqual({});
  });

  it('two accounts with same-named connections each reach their own', async () => {
    const reg = await registry();
    expect(await call(stateFor(reg, { userId: A }), 'discord_messages_send')).toEqual({ url: 'https://gw.example/discord-a' });
    expect(await call(stateFor(reg, { userId: B }), 'discord_messages_send')).toEqual({ url: 'https://gw.example/discord-b' });
  });

  it("account B's run cannot resolve account A's tools", async () => {
    const reg = await registry();
    await expect(call(stateFor(reg, { userId: B }), 'become_get_progress', 'Bearer x'))
      .rejects.toThrow('Tool not found: become_get_progress');
    expect(requests).toHaveLength(0);
  });

  it("a system-owned graph run by A uses A's connections (the run executes as A)", async () => {
    // For a system graph (owner 000...001) the run's userId is the invoker.
    // The graph owner plays no part: SYSTEM owns no connections.
    const reg = await registry();
    const state = stateFor(reg, { userId: A });
    expect(await call(state, 'discord_messages_send')).toEqual({ url: 'https://gw.example/discord-a' });
    expect(resolveRunMcpScope({ userId: A }).userId).not.toBe(SYSTEM);
  });

  it("Become AI: A's graph calls A's Become tool as the end user", async () => {
    const reg = await registry();
    const out = await call(stateFor(reg, { userId: A }), 'become_get_progress', 'Bearer end-user');
    expect(out).toEqual({ url: 'https://gw.example/become/data' });
    expect(requests[0].headers.Authorization).toBe('Bearer end-user');
  });

  it('keeps the scope fixed even if the caller mutates it', async () => {
    const reg = await registry();
    const client = createRunMcpClient(
      (name, args, meta, signal, scope) => reg.callTool(name, args, meta as any, signal, scope),
      { userId: B },
    );
    expect(() => { (client.scope as any).userId = A; }).toThrow();
    await expect(client.callTool('become_get_progress', {})).rejects.toThrow('Tool not found');
  });
});
