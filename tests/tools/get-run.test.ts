/**
 * Vitest for native tool: get_run
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getRunTool from '../../src/lib/tools/native/get-run';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1' },
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('get_run — schema', () => {
  test('requires runId', () => {
    expect(getRunTool.description.toLowerCase()).toContain('run');
    expect(getRunTool.inputSchema.required).toEqual(['runId']);
    expect(getRunTool.inputSchema.properties.runId).toBeDefined();
  });

  test('server label is system', () => {
    expect(getRunTool.server).toBe('system');
  });
});

describe('get_run — validation', () => {
  test('missing runId returns isError + VALIDATION', async () => {
    const r = await getRunTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/runId/);
  });

  test('empty/whitespace runId returns isError + VALIDATION', async () => {
    const r = await getRunTool.handler({ runId: '   ' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('non-string runId returns isError + VALIDATION', async () => {
    const r = await getRunTool.handler({ runId: 42 } as never, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('get_run — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns full RunState wrapped under { run: ... }', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      expect(capturedUrl).toContain('/api/v1/runs/run_x');
      return new Response(
        JSON.stringify({
          runId: 'run_x',
          userId: 'user-1',
          status: 'running',
          graphId: 'graph_y',
          conversationId: 'conv_z',
          startedAt: '2026-04-27T00:00:00.000Z',
          currentNodeId: 'planner',
          output: { content: 'partial...' },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await getRunTool.handler({ runId: 'run_x' }, makeMockContext());
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.run.runId).toBe('run_x');
    expect(body.run.status).toBe('running');
    expect(body.run.currentNodeId).toBe('planner');
    expect(body.run.output.content).toBe('partial...');
  });

  test('encodes runId in URL path', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ runId: 'x' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getRunTool.handler({ runId: 'has spaces & ?' }, makeMockContext());
    expect(capturedUrl).toContain(encodeURIComponent('has spaces & ?'));
  });

  test('forwards bearer + user-id headers from state', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ runId: 'r' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getRunTool.handler(
      { runId: 'r' },
      makeMockContext({ state: { authToken: 'tok-r', userId: 'user-7' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-r');
    expect(capturedHeaders['X-User-Id']).toBe('user-7');
  });

  test('forwards INTERNAL_SERVICE_KEY when present', async () => {
    const previous = process.env.INTERNAL_SERVICE_KEY;
    process.env.INTERNAL_SERVICE_KEY = 'svc-key-test';

    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ runId: 'r' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    try {
      await getRunTool.handler({ runId: 'r' }, makeMockContext());
      expect(capturedHeaders['X-Internal-Key']).toBe('svc-key-test');
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_SERVICE_KEY;
      else process.env.INTERNAL_SERVICE_KEY = previous;
    }
  });
});

describe('get_run — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('404 (run TTL-expired) surfaces status + runId', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Run not found' } }), {
        status: 404,
        statusText: 'Not Found',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getRunTool.handler({ runId: 'run_missing' }, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(404);
    expect(body.runId).toBe('run_missing');
  });

  test('403 (foreign owner) surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Forbidden' } }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getRunTool.handler({ runId: 'someones_run' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(403);
  });

  test('500 returns error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getRunTool.handler({ runId: 'run_x' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const r = await getRunTool.handler({ runId: 'run_x' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });
});
