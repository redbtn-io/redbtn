/**
 * Vitest for native tool: get_graph_compile_log
 *
 * Per PLATFORM-PACK-HANDOFF.md §2 Phase C — happy path + validation +
 * upstream error. The tool proxies to
 * `GET /api/v1/graphs/:graphId/compile-log` so this file exclusively
 * mocks fetch and exercises the wrapper's input handling, URL shape,
 * and error code mapping.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getGraphCompileLogTool from '../../src/lib/tools/native/get-graph-compile-log';

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

describe('get_graph_compile_log — schema', () => {
  test('exposes the documented inputs', () => {
    expect(getGraphCompileLogTool.description.toLowerCase()).toMatch(/compile/);
    expect(getGraphCompileLogTool.inputSchema.required).toEqual(['graphId']);
    expect(getGraphCompileLogTool.inputSchema.properties.graphId).toBeDefined();
    expect(getGraphCompileLogTool.inputSchema.properties.limit).toBeDefined();
    expect(getGraphCompileLogTool.server).toBe('platform');
  });
});

describe('get_graph_compile_log — validation', () => {
  test('missing graphId → isError + VALIDATION', async () => {
    const r = await getGraphCompileLogTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/graphId/);
  });

  test('whitespace-only graphId → isError + VALIDATION', async () => {
    const r = await getGraphCompileLogTool.handler(
      { graphId: '   ' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('get_graph_compile_log — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('hits the correct URL and unwraps logs[]', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({
          logs: [
            {
              compiledAt: '2026-04-27T10:00:00Z',
              status: 'errors',
              errors: [{ severity: 'error', code: 'NO_NODES', message: 'Graph must have at least one node' }],
              warnings: [],
              durationMs: 12,
              trigger: 'create',
            },
          ],
          lastCompiledAt: '2026-04-27T10:00:00Z',
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await getGraphCompileLogTool.handler(
      { graphId: 'red-assistant' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(capturedUrl).toContain('/api/v1/graphs/red-assistant/compile-log');

    const body = JSON.parse(r.content[0].text);
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].errors[0].code).toBe('NO_NODES');
    expect(body.lastCompiledAt).toBe('2026-04-27T10:00:00Z');
  });

  test('limit parameter is forwarded as query string', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ logs: [], lastCompiledAt: null }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getGraphCompileLogTool.handler(
      { graphId: 'g', limit: 5 },
      makeMockContext(),
    );
    expect(capturedUrl).toContain('?limit=5');
  });

  test('limit is clamped to 1..50', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ logs: [], lastCompiledAt: null }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getGraphCompileLogTool.handler(
      { graphId: 'g', limit: 999 },
      makeMockContext(),
    );
    expect(capturedUrl).toContain('limit=50');
  });

  test('encodes graphId in URL path', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ logs: [], lastCompiledAt: null }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getGraphCompileLogTool.handler({ graphId: 'has spaces & ?' }, makeMockContext());
    expect(capturedUrl).toContain(encodeURIComponent('has spaces & ?'));
  });

  test('forwards bearer token + user-id headers from state', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ logs: [], lastCompiledAt: null }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getGraphCompileLogTool.handler(
      { graphId: 'g1' },
      makeMockContext({ state: { authToken: 'tok-x', userId: 'user-2' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-x');
    expect(capturedHeaders['X-User-Id']).toBe('user-2');
  });

  test('empty logs[] array passes through cleanly', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ logs: [], lastCompiledAt: null }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getGraphCompileLogTool.handler({ graphId: 'g' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.logs).toEqual([]);
    expect(body.lastCompiledAt).toBeNull();
  });
});

describe('get_graph_compile_log — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('404 → NOT_FOUND code', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Graph not found' }), {
        status: 404,
        statusText: 'Not Found',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getGraphCompileLogTool.handler({ graphId: 'nope' }, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('NOT_FOUND');
    expect(body.status).toBe(404);
  });

  test('401 → UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('', { status: 401, statusText: 'Unauthorized' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getGraphCompileLogTool.handler({ graphId: 'g' }, makeMockContext());
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('403 → FORBIDDEN', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('', { status: 403, statusText: 'Forbidden' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getGraphCompileLogTool.handler({ graphId: 'g' }, makeMockContext());
    expect(JSON.parse(r.content[0].text).code).toBe('FORBIDDEN');
  });

  test('500 → UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getGraphCompileLogTool.handler({ graphId: 'g' }, makeMockContext());
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    }) as unknown as typeof globalThis.fetch;

    const r = await getGraphCompileLogTool.handler({ graphId: 'g' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ETIMEDOUT/);
  });
});
