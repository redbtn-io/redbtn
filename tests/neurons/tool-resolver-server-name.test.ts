/**
 * tool-resolver — the `conn.` prefix in `mcp:conn.tool` reaches the registry
 * as `serverName`, so two connections exposing the same tool are told apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { createRunMcpClient, resolveRunMcpScope } from '../../src/lib/mcp/run-scope';
import { resolveTools } from '../../src/lib/tools/tool-resolver';

const A = 'account-a';

describe('tool-resolver serverName routing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? 1, result: { content: [{ type: 'text', text: JSON.stringify({ via: String(url) }) }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  async function state() {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'board-one', url: 'https://gw.example/one', tools: ['redboard_comment_post'], ownerUserId: A });
    await reg.registerStaticServer({ name: 'board-two', url: 'https://gw.example/two', tools: ['redboard_comment_post'], ownerUserId: A });
    return {
      data: {},
      mcpClient: createRunMcpClient(
        (name, args, meta, signal, scope, serverName) => reg.callTool(name, args, meta as any, signal, scope, serverName),
        resolveRunMcpScope({ userId: A }),
        (name, scope, serverName) => reg.findTool(name, scope, serverName),
      ),
    } as Record<string, unknown>;
  }

  async function invoke(stateObj: Record<string, unknown>, ref: string) {
    const [tool] = await resolveTools([ref], stateObj);
    return tool.invoke({}, { state: stateObj, runId: 'r', toolId: 't', abortSignal: null });
  }

  it('prefix picks the right connection', async () => {
    const s = await state();
    expect(await invoke(s, 'mcp:board-two.redboard_comment_post')).toEqual({ via: 'https://gw.example/two' });
  });

  it('unknown prefix falls back to first match', async () => {
    const s = await state();
    expect(await invoke(s, 'mcp:nope.redboard_comment_post')).toEqual({ via: 'https://gw.example/one' });
  });

  it('no prefix is first match', async () => {
    const s = await state();
    expect(await invoke(s, 'mcp:redboard_comment_post')).toEqual({ via: 'https://gw.example/one' });
  });
});
