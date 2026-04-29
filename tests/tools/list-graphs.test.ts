/**
 * Vitest for native tool: list_graphs
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import listGraphsTool from '../../src/lib/tools/native/list-graphs';

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

describe('list_graphs — schema', () => {
  test('exposes search + mine + limit, no required fields', () => {
    expect(listGraphsTool.description.toLowerCase()).toContain('graphs');
    expect(listGraphsTool.inputSchema.required).toEqual([]);
    expect(listGraphsTool.inputSchema.properties.search).toBeDefined();
    expect(listGraphsTool.inputSchema.properties.mine).toBeDefined();
    expect(listGraphsTool.inputSchema.properties.limit).toBeDefined();
  });
});

describe('list_graphs — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns mapped graphs (graphId/name/description/isOwned/isSystem)', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('/api/v1/graphs');
      expect(u).toContain('limit=100');
      return new Response(
        JSON.stringify({
          graphs: [
            { graphId: 'g1', name: 'Alpha', description: 'a', isOwned: true,  isSystem: false },
            { graphId: 'g2', name: 'Sys',   description: '',  isOwned: false, isSystem: true  },
            { graphId: 'g3', name: 'Pub',   description: 'p', isOwned: false, isSystem: false },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await listGraphsTool.handler({}, makeMockContext());
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.graphs).toHaveLength(3);
    expect(body.graphs[0]).toEqual({
      graphId: 'g1',
      name: 'Alpha',
      description: 'a',
      isOwned: true,
      isSystem: false,
    });
    expect(body.graphs[1].isSystem).toBe(true);
  });

  test('search filter is forwarded as a query param', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ graphs: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listGraphsTool.handler({ search: 'cooking' }, makeMockContext());
    expect(capturedUrl).toContain('search=cooking');
  });

  test('mine: true narrows to owned graphs', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          graphs: [
            { graphId: 'g1', name: 'A', isOwned: true,  isSystem: false },
            { graphId: 'g2', name: 'B', isOwned: false, isSystem: false },
            { graphId: 'g3', name: 'C', isOwned: true,  isSystem: false },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await listGraphsTool.handler({ mine: true }, makeMockContext());
    const body = JSON.parse(r.content[0].text);
    expect(body.graphs).toHaveLength(2);
    expect(body.graphs.map((g: { graphId: string }) => g.graphId)).toEqual(['g1', 'g3']);
  });

  test('limit clamps the result list', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          graphs: Array.from({ length: 5 }, (_, i) => ({
            graphId: `g${i}`,
            name: `G${i}`,
            isOwned: false,
            isSystem: false,
          })),
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await listGraphsTool.handler({ limit: 2 }, makeMockContext());
    const body = JSON.parse(r.content[0].text);
    expect(body.graphs).toHaveLength(2);
  });

  test('forwards Authorization header from state.authToken', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ graphs: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listGraphsTool.handler(
      {},
      makeMockContext({ state: { authToken: 'tok123', userId: 'user-1' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok123');
    expect(capturedHeaders['X-User-Id']).toBe('user-1');
  });
});

describe('list_graphs — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await listGraphsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const r = await listGraphsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });
});
