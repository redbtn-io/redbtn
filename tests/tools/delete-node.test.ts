/**
 * Vitest for native tool: delete_node
 *
 * Critical: REFUSES isSystem nodes (SYSTEM_ASSET_PROTECTED). Note that the
 * GET /api/v1/nodes/:nodeId route returns the node fields at the TOP LEVEL,
 * not nested under "node". The delete tool reflects that.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import deleteNodeTool from '../../src/lib/tools/native/delete-node';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('delete_node — schema', () => {
  test('nodeId required', () => {
    expect(deleteNodeTool.server).toBe('platform');
    expect(deleteNodeTool.inputSchema.required).toEqual(['nodeId']);
  });
});

describe('delete_node — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('deletes user-owned node after isSystem check passes', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const method = init?.method || 'GET';
      calls.push({ url, method });
      if (method === 'GET') {
        // Note: nodes endpoint returns top-level fields (not nested in "node")
        return new Response(
          JSON.stringify({ nodeId: 'n1', name: 'My Custom Node', isSystem: false, isOwned: true }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true, nodeId: 'n1' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteNodeTool.handler({ nodeId: 'n1' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, nodeId: 'n1' });
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe('DELETE');
  });
});

describe('delete_node — system asset protection', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('REFUSES isSystem: true (never calls DELETE)', async () => {
    let deleteCalled = false;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'GET') {
        return new Response(JSON.stringify({ nodeId: 'context', isSystem: true }), { status: 200 });
      }
      deleteCalled = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteNodeTool.handler({ nodeId: 'context' }, makeMockContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.code).toBe('SYSTEM_ASSET_PROTECTED');
    expect(parsed.error).toMatch(/fork it first/);
    expect(deleteCalled).toBe(false);
  });
});

describe('delete_node — validation errors', () => {
  test('missing nodeId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await deleteNodeTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('delete_node — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('peek 401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await deleteNodeTool.handler({ nodeId: 'n1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('delete 500 (after passing isSystem) surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'GET') {
        return new Response(JSON.stringify({ nodeId: 'n1', isSystem: false }), { status: 200 });
      }
      return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
    }) as unknown as typeof globalThis.fetch;
    const r = await deleteNodeTool.handler({ nodeId: 'n1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
