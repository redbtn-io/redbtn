/**
 * McpRegistry — account-owned servers.
 *
 * A server registered with `ownerUserId` must only resolve for runs whose graph
 * belongs to that account; global registrations keep resolving for everyone.
 * Per-call credentials (`_meta.credentials.headers`, the neuron step's
 * `toolCredentials`) must still be promoted onto the HTTP request for owned
 * static servers — that is how the Become AI graph authenticates as the end
 * user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../src/lib/mcp/registry';

const OWNER = 'owner-user-1';
const OTHER = 'other-user-2';

type Captured = { url: string; headers: Record<string, string>; body: any };

function stubFetch(captured: Captured[]) {
  const fetchMock = vi.fn(async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    captured.push({ url: String(url), headers: { ...(init?.headers ?? {}) }, body });
    if (String(url).endsWith('/health')) {
      return new Response(JSON.stringify({ status: 'ok', tools: ['acct_tool_a', 'acct_tool_b'] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('McpRegistry owner scoping', () => {
  let captured: Captured[];

  beforeEach(() => {
    captured = [];
    stubFetch(captured);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps unowned (global) servers visible to every scope', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'global', url: 'https://gw.example/global', tools: ['g_tool'] });

    expect(reg.findTool('g_tool')?.server).toBe('global');
    expect(reg.findTool('g_tool', { userId: OWNER })?.server).toBe('global');
    expect(reg.findTool('g_tool', { userId: OTHER })?.server).toBe('global');
  });

  it('resolves an owned server only for its owner', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({
      name: `become@${OWNER}`,
      url: 'https://gw.example/become/data',
      tools: ['acct_tool_a'],
      ownerUserId: OWNER,
    });

    expect(reg.findTool('acct_tool_a', { userId: OWNER })?.server).toBe(`become@${OWNER}`);
    expect(reg.findTool('acct_tool_a', { userId: OTHER })).toBeUndefined();
    // Unscoped lookups never see owned servers.
    expect(reg.findTool('acct_tool_a')).toBeUndefined();
    expect(reg.getServer(`become@${OWNER}`)?.ownerUserId).toBe(OWNER);
  });

  it('refuses to call an owned tool from another account', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({
      name: 'acct',
      url: 'https://gw.example/acct',
      tools: ['acct_tool_a'],
      ownerUserId: OWNER,
    });

    await expect(reg.callTool('acct_tool_a', {}, undefined, undefined, { userId: OTHER }))
      .rejects.toThrow('Tool not found: acct_tool_a');
    await expect(reg.callTool('acct_tool_a', {})).rejects.toThrow('Tool not found');
    expect(captured).toHaveLength(0);
  });

  it('prefers the account-owned server over a global one with the same tool', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'global', url: 'https://gw.example/global', tools: ['dup'] });
    await reg.registerStaticServer({ name: 'mine', url: 'https://gw.example/mine', tools: ['dup'], ownerUserId: OWNER });

    expect(reg.findTool('dup', { userId: OWNER })?.server).toBe('mine');
    expect(reg.findTool('dup', { userId: OTHER })?.server).toBe('global');
  });

  it('filters getAllTools by scope, and returns everything unscoped', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'global', url: 'https://gw.example/global', tools: ['g'] });
    await reg.registerStaticServer({ name: 'mine', url: 'https://gw.example/mine', tools: ['m'], ownerUserId: OWNER });

    expect(reg.getAllTools().map(t => t.tool.name).sort()).toEqual(['g', 'm']);
    expect(reg.getAllTools({ userId: OWNER }).map(t => t.tool.name).sort()).toEqual(['g', 'm']);
    expect(reg.getAllTools({ userId: OTHER }).map(t => t.tool.name)).toEqual(['g']);
  });

  it('injects the per-call bearer for an owned static server with no stored auth', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({
      name: 'acct',
      url: 'https://gw.example/become/data',
      tools: ['acct_tool_a'],
      messagePath: '',
      ownerUserId: OWNER,
    });

    const result = await reg.callTool(
      'acct_tool_a',
      { period: 'week' },
      { credentials: { type: 'bearer', headers: { Authorization: 'Bearer end-user-token' } } as any },
      undefined,
      { userId: OWNER },
    );

    expect(result?.content?.[0]?.text).toBe('{"ok":true}');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://gw.example/become/data');
    expect(captured[0].headers.Authorization).toBe('Bearer end-user-token');
    expect(captured[0].body.method).toBe('tools/call');
    expect(captured[0].body.params._meta.credentials.headers.Authorization).toBe('Bearer end-user-token');
  });

  it('still falls back to the /health roster when no tool list is given', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'acct', url: 'https://gw.example/acct', ownerUserId: OWNER });

    expect(captured.map(c => c.url)).toEqual(['https://gw.example/acct/health']);
    expect(reg.getAllTools({ userId: OWNER }).map(t => t.tool.name).sort()).toEqual(['acct_tool_a', 'acct_tool_b']);
  });

  it('records the owner on handshake-registered servers too', async () => {
    const reg = new McpRegistry();
    // Minimal handshake stub: initialize -> tools/list.
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const result = body.method === 'initialize'
        ? { serverInfo: { name: 'srv', version: '1' }, capabilities: {} }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'hs_tool', description: '', inputSchema: { type: 'object' } }] }
          : {};
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await reg.registerServer({ name: 'hs', url: 'https://gw.example/hs', ownerUserId: OWNER });
    expect(reg.getServer('hs')?.ownerUserId).toBe(OWNER);
    expect(reg.findTool('hs_tool', { userId: OTHER })).toBeUndefined();
    expect(reg.findTool('hs_tool', { userId: OWNER })?.server).toBe('hs');
  });
});
