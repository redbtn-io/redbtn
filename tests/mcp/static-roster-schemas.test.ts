/**
 * Neurons must see an MCP tool's real description and input schema.
 *
 * 2026-10-12: the Become dispatcher (a neuron with `mcp:discord_messages_send`)
 * kept getting Discord 10003 "Unknown Channel" for a channel the bot is in. The
 * model was handed an empty object schema, guessed `channel_id`, then sent the
 * 64-bit channel id as a JSON number, which every JSON parser rounds
 * (1486836793558175785 -> 1486836793558175700). Two gaps produced the empty
 * schema:
 *
 *  1. the run-context `mcpClient` (lib/mcp/run-scope; a callTool-only wrapper
 *     since #176) had no `findTool`, so the tool resolver never found ANY MCP
 *     tool's schema;
 *  2. static registrations (first-party gateway connections) only kept tool
 *     names, although the connection document caches full definitions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry, normalizeStaticRoster } from '../../src/lib/mcp/registry';
import { createRunMcpClient, resolveRunMcpScope } from '../../src/lib/mcp/run-scope';
import { resolveTools, toBindToolsPayload } from '../../src/lib/tools/tool-resolver';

const A = 'account-a';
const B = 'account-b';

const SEND_DEF = {
  name: 'discord_messages_send',
  description: 'Send a message to a Discord text channel as the bot.',
  inputSchema: {
    type: 'object',
    properties: {
      channelId: { type: 'string', description: 'Snowflake id of the target channel.' },
      content: { type: 'string', description: 'Message text.' },
    },
    required: ['channelId', 'content'],
  },
};

describe('normalizeStaticRoster', () => {
  it('keeps cached definitions and falls back to permissive schemas for bare names', () => {
    const tools = normalizeStaticRoster([SEND_DEF, 'discord_users_get_self'], 'Discord');
    expect(tools[0]).toEqual(SEND_DEF);
    expect(tools[1]).toEqual({
      name: 'discord_users_get_self',
      description: 'MCP tool discord_users_get_self on Discord',
      inputSchema: { type: 'object', properties: {} },
    });
  });

  it('clones schemas so later mutation of the source cannot leak in', () => {
    const def = structuredClone(SEND_DEF);
    const [tool] = normalizeStaticRoster([def], 'Discord');
    (def.inputSchema.properties as any).channelId.type = 'number';
    expect((tool.inputSchema.properties as any).channelId.type).toBe('string');
  });

  it('drops unnamed entries and duplicates; ignores non-object schemas', () => {
    const tools = normalizeStaticRoster(
      [
        { name: '' },
        null,
        42,
        { description: 'no name' },
        SEND_DEF,
        { name: 'discord_messages_send', inputSchema: { type: 'object', properties: {} } },
        { name: 'weird', description: '   ', inputSchema: { type: 'string' } },
        { name: 'arr', inputSchema: [] },
        { name: 'noprops', inputSchema: { type: 'object' } },
      ],
      'S',
    );
    expect(tools.map((t) => t.name)).toEqual(['discord_messages_send', 'weird', 'arr', 'noprops']);
    expect(tools[0].inputSchema).toEqual(SEND_DEF.inputSchema);
    expect(tools[1]).toEqual({ name: 'weird', description: 'MCP tool weird on S', inputSchema: { type: 'object', properties: {} } });
    expect(tools[2].inputSchema).toEqual({ type: 'object', properties: {} });
    expect(tools[3].inputSchema).toEqual({ type: 'object', properties: {} });
  });
});

describe('neurons see MCP tool schemas through the run-scoped client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok', tools: ['probe_tool'] }), { status: 200 });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: body?.id, result: { content: [{ type: 'text', text: JSON.stringify(body?.params?.arguments ?? {}) }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function registry() {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'Discord', url: 'https://gw.example/discord', tools: [SEND_DEF], messagePath: '', ownerUserId: A });
    await reg.registerStaticServer({ name: 'Discord', url: 'https://gw.example/discord-b', tools: ['discord_messages_send'], messagePath: '', ownerUserId: B });
    return reg;
  }

  function stateFor(reg: McpRegistry, userId: string, withFinder = true) {
    return {
      data: {},
      mcpClient: createRunMcpClient(
        (name, args, meta, signal, scope) => reg.callTool(name, args, meta as any, signal, scope),
        resolveRunMcpScope({ userId }),
        withFinder ? (name, scope) => reg.findTool(name, scope) : undefined,
      ),
    } as Record<string, unknown>;
  }

  it('resolves the cached schema and description for mcp: refs (both name forms)', async () => {
    const reg = await registry();
    const state = stateFor(reg, A);
    const [bare, qualified] = await resolveTools(['mcp:discord_messages_send', 'mcp:discord.discord_messages_send'], state);
    for (const tool of [bare, qualified]) {
      expect(tool.description).toBe(SEND_DEF.description);
      expect((tool.inputSchema as any).properties.channelId).toEqual({ type: 'string', description: 'Snowflake id of the target channel.' });
      expect((tool.inputSchema as any).required).toEqual(['channelId', 'content']);
    }
    expect(qualified.name).toBe('discord__discord_messages_send');
    const [payload] = toBindToolsPayload([bare]);
    expect((payload.schema as any).properties.channelId.type).toBe('string');
  });

  it('stays inside the run account: B gets its own (name-only) registration, never A\'s schema', async () => {
    const reg = await registry();
    const [tool] = await resolveTools(['mcp:discord_messages_send'], stateFor(reg, B));
    expect(tool.description).toBe('MCP tool discord_messages_send on Discord');
    expect((tool.inputSchema as any).properties).toEqual({});
  });

  it('findTool is scoped exactly like callTool', async () => {
    const reg = await registry();
    const client: any = (stateFor(reg, A) as any).mcpClient;
    expect(client.findTool('discord_messages_send')?.tool.inputSchema).toEqual(SEND_DEF.inputSchema);
    const none: any = (stateFor(reg, 'someone-else') as any).mcpClient;
    expect(none.findTool('discord_messages_send')).toBeUndefined();
  });

  it('without a finder the client still works but reports no schema (old behaviour)', async () => {
    const reg = await registry();
    const state = stateFor(reg, A, false);
    const [tool] = await resolveTools(['mcp:discord_messages_send'], state);
    expect((tool.inputSchema as any).properties).toEqual({});
    const out = await tool.invoke({ channelId: '1486836793558175785', content: 'x' }, { state, runId: 'r', toolId: 't', abortSignal: null });
    expect(out).toEqual({ channelId: '1486836793558175785', content: 'x' });
  });

  it('an empty roster still falls back to the /health probe (names only)', async () => {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'Probe', url: 'https://gw.example/probe', tools: [], messagePath: '', ownerUserId: A });
    expect(reg.findTool('probe_tool', { userId: A })?.tool.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});
