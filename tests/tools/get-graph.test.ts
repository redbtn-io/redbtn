/**
 * Vitest for native tool: get_graph
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getGraphTool from '../../src/lib/tools/native/get-graph';

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

describe('get_graph — schema', () => {
  test('requires graphId', () => {
    expect(getGraphTool.description.toLowerCase()).toContain('graph');
    expect(getGraphTool.inputSchema.required).toEqual(['graphId']);
    expect(getGraphTool.inputSchema.properties.graphId).toBeDefined();
  });
});

describe('get_graph — validation', () => {
  test('missing graphId returns isError: true with VALIDATION code', async () => {
    const r = await getGraphTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/graphId/);
  });

  test('empty graphId string returns isError: true', async () => {
    const r = await getGraphTool.handler({ graphId: '   ' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('get_graph — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns full graph definition (unwrapped from { graph: ... })', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('/api/v1/graphs/red-assistant');
      return new Response(
        JSON.stringify({
          graph: {
            graphId: 'red-assistant',
            name: 'Red Assistant',
            description: 'The default conversation graph',
            nodes: [{ id: 'context' }, { id: 'router' }],
            edges: [{ from: 'context', to: 'router' }],
            inputSchema: [{ name: 'message', type: 'string' }],
            isOwned: false,
            isSystem: true,
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await getGraphTool.handler(
      { graphId: 'red-assistant' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.graph.graphId).toBe('red-assistant');
    expect(body.graph.name).toBe('Red Assistant');
    expect(body.graph.nodes).toHaveLength(2);
    expect(body.graph.inputSchema).toBeDefined();
  });

  test('encodes graphId in URL path', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ graph: {} }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getGraphTool.handler({ graphId: 'has spaces & ?' }, makeMockContext());
    // URL-encoded form
    expect(capturedUrl).toContain(encodeURIComponent('has spaces & ?'));
  });

  test('forwards bearer token + user-id headers from state', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ graph: { graphId: 'g1' } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getGraphTool.handler(
      { graphId: 'g1' },
      makeMockContext({ state: { authToken: 'tok-x', userId: 'user-2' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-x');
    expect(capturedHeaders['X-User-Id']).toBe('user-2');
  });
});

describe('get_graph — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('404 surfaces status + graphId', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Graph not found' }), {
        status: 404,
        statusText: 'Not Found',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getGraphTool.handler({ graphId: 'nope' }, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(404);
    expect(body.graphId).toBe('nope');
  });

  test('500 returns error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    }) as unknown as typeof globalThis.fetch;

    const r = await getGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ETIMEDOUT/);
  });
});
