/**
 * Vitest for native tool: delete_graph
 *
 * Critical case: the tool must REFUSE to delete any graph with isSystem:true
 * (or userId === 'system'). The check happens via a GET before the DELETE;
 * tests assert that the DELETE is never even reached for system graphs.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import deleteGraphTool from '../../src/lib/tools/native/delete-graph';

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

describe('delete_graph — schema', () => {
  test('graphId is required', () => {
    expect(deleteGraphTool.server).toBe('platform');
    expect(deleteGraphTool.inputSchema.required).toEqual(['graphId']);
  });
});

describe('delete_graph — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('deletes a user-owned graph after isSystem check passes', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const method = init?.method || 'GET';
      calls.push({ url, method });
      if (method === 'GET') {
        return new Response(
          JSON.stringify({ graph: { graphId: 'g1', userId: 'user-abc', isSystem: false } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true, graphId: 'g1' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, graphId: 'g1' });
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('GET');
    expect(calls[1].method).toBe('DELETE');
  });
});

describe('delete_graph — system asset protection', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('REFUSES delete when isSystem: true (never calls DELETE)', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const method = init?.method || 'GET';
      calls.push({ url, method });
      if (method === 'GET') {
        return new Response(
          JSON.stringify({ graph: { graphId: 'red-assistant', userId: 'system', isSystem: true } }),
          { status: 200 },
        );
      }
      throw new Error('DELETE should NEVER be called for system graphs');
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteGraphTool.handler({ graphId: 'red-assistant' }, makeMockContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.code).toBe('SYSTEM_ASSET_PROTECTED');
    expect(parsed.error).toMatch(/fork it first/);
    expect(parsed.graphId).toBe('red-assistant');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  test('REFUSES delete when userId === "system" even without isSystem flag', async () => {
    let deleteCalled = false;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'GET') {
        return new Response(JSON.stringify({ graph: { graphId: 'sys', userId: 'system' } }), { status: 200 });
      }
      deleteCalled = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteGraphTool.handler({ graphId: 'sys' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('SYSTEM_ASSET_PROTECTED');
    expect(deleteCalled).toBe(false);
  });
});

describe('delete_graph — validation errors', () => {
  test('missing graphId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await deleteGraphTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('delete_graph — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('peek 401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await deleteGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('peek 404 surfaces NOT_FOUND', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Not Found', { status: 404, statusText: 'Not Found' })) as unknown as typeof globalThis.fetch;
    const r = await deleteGraphTool.handler({ graphId: 'phantom' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('NOT_FOUND');
  });

  test('delete 500 (after passing isSystem check) surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'GET') {
        return new Response(JSON.stringify({ graph: { graphId: 'g1', userId: 'me', isSystem: false } }), { status: 200 });
      }
      return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
    }) as unknown as typeof globalThis.fetch;
    const r = await deleteGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.status).toBe(500);
    expect(parsed.code).toBe('UPSTREAM_ERROR');
  });
});
