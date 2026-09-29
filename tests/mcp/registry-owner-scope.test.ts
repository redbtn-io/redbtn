/**
 * McpRegistry — every MCP connection belongs to an account.
 *
 * George: "when I add an mcp server to my account, that tool suddenly becomes
 * available for anyone on the platform. Uh no, get rid of that."
 *
 * - servers are keyed by (ownerUserId, name): same-named connections on two
 *   accounts both load and never shadow each other;
 * - a lookup only searches the executing account's servers (plus explicitly
 *   platform-level servers);
 * - a registration without an owner is refused (no accidental global);
 * - per-call credentials (`_meta.credentials.headers`, the neuron step's
 *   `toolCredentials`) are still promoted onto the HTTP request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../src/lib/mcp/registry';

const A = 'account-a';
const B = 'account-b';

type Captured = { url: string; headers: Record<string, string>; body: any };

describe('McpRegistry account scoping', () => {
  let captured: Captured[];

  beforeEach(() => {
    captured = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      captured.push({ url: String(url), headers: { ...(init?.headers ?? {}) }, body });
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok', tools: ['acct_tool_a', 'acct_tool_b'] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? 1, result: { content: [{ type: 'text', text: JSON.stringify({ via: String(url) }) }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('refuses a registration with no owner (no accidental global server)', async () => {
    const reg = new McpRegistry();
    await expect(reg.registerStaticServer({ name: 'x', url: 'https://gw.example/x', tools: ['t'] }))
      .rejects.toThrow(/no ownerUserId/);
    await expect(reg.registerServer({ name: 'x', url: 'https://gw.example/x' }))
      .rejects.toThrow(/no ownerUserId/);
    expect(captured).toHaveLength(0);
  });

  it('loads same-named connections on two accounts side by side; each account reaches only its own', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'RedRun', url: 'https://gw.example/a', tools: ['redrun_workspace_get'], ownerUserId: A });
    await reg.registerStaticServer({ name: 'RedRun', url: 'https://gw.example/b', tools: ['redrun_workspace_get'], ownerUserId: B });

    expect(reg.getServer('RedRun', A)?.url).toBe('https://gw.example/a');
    expect(reg.getServer('RedRun', B)?.url).toBe('https://gw.example/b');
    expect(reg.getAllServers()).toHaveLength(2);

    const ra = await reg.callTool('redrun_workspace_get', {}, undefined, undefined, { userId: A });
    const rb = await reg.callTool('redrun_workspace_get', {}, undefined, undefined, { userId: B });
    expect(JSON.parse(ra.content[0].text).via).toBe('https://gw.example/a');
    expect(JSON.parse(rb.content[0].text).via).toBe('https://gw.example/b');
  });

  it("never lets account B resolve account A's tools", async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'Discord', url: 'https://gw.example/discord', tools: ['discord_messages_send'], ownerUserId: A });

    expect(reg.findTool('discord_messages_send', { userId: A })?.server).toBe('Discord');
    expect(reg.findTool('discord_messages_send', { userId: B })).toBeUndefined();
    expect(reg.findTool('discord_messages_send')).toBeUndefined();
    expect(reg.getAllTools({ userId: B })).toEqual([]);
    expect(reg.getAllTools()).toEqual([]);
    await expect(reg.callTool('discord_messages_send', {}, undefined, undefined, { userId: B }))
      .rejects.toThrow('Tool not found: discord_messages_send');
    await expect(reg.callTool('discord_messages_send', {})).rejects.toThrow('Tool not found');
    expect(captured).toHaveLength(0);
  });

  it('unregisters one account without touching the other', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'RedRun', url: 'https://gw.example/a', tools: ['t'], ownerUserId: A });
    await reg.registerStaticServer({ name: 'RedRun', url: 'https://gw.example/b', tools: ['t'], ownerUserId: B });
    await reg.unregisterServer('RedRun', B);
    expect(reg.getServer('RedRun', B)).toBeUndefined();
    expect(reg.findTool('t', { userId: A })?.server).toBe('RedRun');
    // No owner => no-op, never a wildcard.
    await reg.unregisterServer('RedRun');
    expect(reg.getServer('RedRun', A)).toBeDefined();
  });

  it('platform servers must be declared explicitly and are visible to every account', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'plat', url: 'https://gw.example/p', tools: ['shared'], platform: true });
    await reg.registerStaticServer({ name: 'mine', url: 'https://gw.example/m', tools: ['shared'], ownerUserId: A });

    // The account's own connection wins over the platform one.
    expect(reg.findTool('shared', { userId: A })?.server).toBe('mine');
    expect(reg.findTool('shared', { userId: B })?.server).toBe('plat');
    expect(reg.getServer('plat', undefined, { platform: true })?.platform).toBe(true);
  });

  it('injects the per-call bearer for an account static server with no stored auth', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'Become', url: 'https://gw.example/become/data', tools: ['acct_tool_a'], messagePath: '', ownerUserId: A });

    await reg.callTool(
      'acct_tool_a',
      { period: 'week' },
      { credentials: { type: 'bearer', headers: { Authorization: 'Bearer end-user-token' } } as any },
      undefined,
      { userId: A },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://gw.example/become/data');
    expect(captured[0].headers.Authorization).toBe('Bearer end-user-token');
    expect(captured[0].body.params._meta.credentials.headers.Authorization).toBe('Bearer end-user-token');
  });

  it('still falls back to the /health roster when no tool list is given', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'acct', url: 'https://gw.example/acct', ownerUserId: A });
    expect(captured.map(c => c.url)).toEqual(['https://gw.example/acct/health']);
    expect(reg.getAllTools({ userId: A }).map(t => t.tool.name).sort()).toEqual(['acct_tool_a', 'acct_tool_b']);
  });

  it('scopes handshake-registered servers too', async () => {
    const reg = new McpRegistry();
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const result = body.method === 'initialize'
        ? { serverInfo: { name: 'srv', version: '1' }, capabilities: {} }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'hs_tool', description: '', inputSchema: { type: 'object' } }] }
          : {};
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));

    await reg.registerServer({ name: 'hs', url: 'https://gw.example/hs', ownerUserId: A });
    expect(reg.getServer('hs', A)?.ownerUserId).toBe(A);
    expect(reg.findTool('hs_tool', { userId: B })).toBeUndefined();
    expect(reg.findTool('hs_tool', { userId: A })?.server).toBe('hs');
  });
});
