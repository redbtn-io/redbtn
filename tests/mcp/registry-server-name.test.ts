/**
 * McpRegistry — `serverName` routing for duplicate tool names.
 *
 * Two connections exposing the same tool (e.g. `redboard_comment_post` on two
 * redboard connections) are told apart by the `conn.` prefix: `findTool` /
 * `callTool` prefer the visible registration whose `connectionName` matches,
 * and fall back to first-match when the prefix names nothing visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../src/lib/mcp/registry';

const A = 'account-a';

describe('McpRegistry serverName routing', () => {
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

  async function registry() {
    const reg = new McpRegistry();
    await reg.registerStaticServer({ name: 'board-one', url: 'https://gw.example/one', tools: ['redboard_comment_post'], ownerUserId: A });
    await reg.registerStaticServer({ name: 'board-two', url: 'https://gw.example/two', tools: ['redboard_comment_post'], ownerUserId: A });
    return reg;
  }

  it('prefix picks the right connection (case-insensitive)', async () => {
    const reg = await registry();
    expect(reg.findTool('redboard_comment_post', { userId: A }, 'board-two')?.server).toBe('board-two');
    expect(reg.findTool('redboard_comment_post', { userId: A }, 'BOARD-ONE')?.server).toBe('board-one');
    const out = await reg.callTool('redboard_comment_post', {}, undefined, undefined, { userId: A }, 'board-two');
    expect(JSON.parse(out.content[0].text).via).toBe('https://gw.example/two');
  });

  it('unknown prefix falls back to first match', async () => {
    const reg = await registry();
    expect(reg.findTool('redboard_comment_post', { userId: A }, 'nope')?.server).toBe('board-one');
    const out = await reg.callTool('redboard_comment_post', {}, undefined, undefined, { userId: A }, 'nope');
    expect(JSON.parse(out.content[0].text).via).toBe('https://gw.example/one');
  });

  it('no prefix is first match, as today', async () => {
    const reg = await registry();
    expect(reg.findTool('redboard_comment_post', { userId: A })?.server).toBe('board-one');
    const out = await reg.callTool('redboard_comment_post', {}, undefined, undefined, { userId: A });
    expect(JSON.parse(out.content[0].text).via).toBe('https://gw.example/one');
  });
});
