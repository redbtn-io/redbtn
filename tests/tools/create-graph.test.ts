/**
 * Vitest for native tool: create_graph
 *
 * Per PLATFORM-PACK-HANDOFF.md §7 — happy path + validation + auth + 4xx + 5xx.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import createGraphTool from '../../src/lib/tools/native/create-graph';

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

describe('create_graph — schema', () => {
  test('config is required, graphId optional, server is platform', () => {
    expect(createGraphTool.server).toBe('platform');
    expect(createGraphTool.inputSchema.required).toEqual(['config']);
    expect(createGraphTool.inputSchema.properties.config).toBeDefined();
    expect(createGraphTool.inputSchema.properties.graphId).toBeDefined();
  });
});

describe('create_graph — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns { graphId, createdAt, name } on 201 Created', async () => {
    const createdAt = new Date('2026-04-27T12:00:00Z').toISOString();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/graphs');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.name).toBe('Hello Graph');
      return new Response(
        JSON.stringify({ graphId: 'g_abc123', name: 'Hello Graph', createdAt }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await createGraphTool.handler(
      {
        config: {
          name: 'Hello Graph',
          nodes: [{ id: 'context' }],
          edges: [{ from: '__start__', to: 'context' }],
        },
      },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      graphId: 'g_abc123',
      name: 'Hello Graph',
      createdAt,
    });
  });

  test('forwards graphId at top level when provided', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ graphId: 'my-id', createdAt: 'now' }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    await createGraphTool.handler(
      { graphId: 'my-id', config: { name: 'X', nodes: [{ id: 'a' }], edges: [] } },
      makeMockContext(),
    );
    expect(captured.graphId).toBe('my-id');
    expect(captured.name).toBe('X');
  });

  test('Bearer token from state.authToken is forwarded', async () => {
    let authHeader = '';
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      authHeader = (init?.headers as Record<string, string>)?.['Authorization'] || '';
      return new Response(JSON.stringify({ graphId: 'g', createdAt: 'now' }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    await createGraphTool.handler(
      { config: { name: 'X', nodes: [{ id: 'a' }], edges: [] } },
      makeMockContext({ state: { authToken: 'jwt-xyz' } }),
    );
    expect(authHeader).toBe('Bearer jwt-xyz');
  });
});

describe('create_graph — validation errors', () => {
  test('missing config returns isError + VALIDATION', async () => {
    // @ts-expect-error
    const r = await createGraphTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('config not an object returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await createGraphTool.handler({ config: 'oops' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('create_graph — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('401 surfaces UNAUTHORIZED code', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await createGraphTool.handler(
      { config: { name: 'X', nodes: [{ id: 'a' }], edges: [] } },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.status).toBe(401);
    expect(parsed.code).toBe('UNAUTHORIZED');
  });

  test('400 surfaces UPSTREAM_ERROR code (4xx)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400, statusText: 'Bad Request',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await createGraphTool.handler(
      { config: { name: 'X', nodes: [{ id: 'a' }], edges: [] } },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(400);
  });

  test('500 surfaces UPSTREAM_ERROR (5xx)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await createGraphTool.handler(
      { config: { name: 'X', nodes: [{ id: 'a' }], edges: [] } },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.status).toBe(500);
    expect(parsed.code).toBe('UPSTREAM_ERROR');
  });

  test('429 surfaces LIMIT_EXCEEDED code', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Graph limit reached' }), {
        status: 429, statusText: 'Too Many Requests',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await createGraphTool.handler(
      { config: { name: 'X', nodes: [{ id: 'a' }], edges: [] } },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('LIMIT_EXCEEDED');
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED webapp');
    }) as unknown as typeof globalThis.fetch;

    const r = await createGraphTool.handler(
      { config: { name: 'X', nodes: [{ id: 'a' }], edges: [] } },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });
});
