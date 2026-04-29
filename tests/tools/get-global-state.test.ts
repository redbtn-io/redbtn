/**
 * Vitest for native tool: get_global_state
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * The handler talks to the webapp's /api/v1/state API via global `fetch`.
 * We mock fetch to keep the suite deterministic and offline.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getGlobalStateTool from '../../src/lib/tools/native/get-global-state';

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

describe('get_global_state — schema', () => {
  test('exposes required and optional inputs per spec', () => {
    expect(getGlobalStateTool.description.toLowerCase()).toMatch(/global-state|namespace/);
    expect(getGlobalStateTool.inputSchema.required).toEqual(['namespace', 'key']);
    expect(getGlobalStateTool.inputSchema.properties.namespace).toBeDefined();
    expect(getGlobalStateTool.inputSchema.properties.key).toBeDefined();
    expect(getGlobalStateTool.server).toBe('state');
  });
});

describe('get_global_state — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebappUrl: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebappUrl = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebappUrl === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = originalWebappUrl;
    vi.restoreAllMocks();
  });

  test('returns { value, exists: true } when API returns the value', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      // Confirm URL targets the right endpoint
      expect(u).toBe(
        'http://test-webapp.example/api/v1/state/namespaces/prefs/values/favourite_color',
      );
      return new Response(
        JSON.stringify({ key: 'favourite_color', value: 'red' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await getGlobalStateTool.handler(
      { namespace: 'prefs', key: 'favourite_color' },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ value: 'red', exists: true });
  });

  test('returns complex JSON values intact', async () => {
    const complex = { count: 42, tags: ['a', 'b'], nested: { ok: true } };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ key: 'state', value: complex }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await getGlobalStateTool.handler(
      { namespace: 'app', key: 'state' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.exists).toBe(true);
    expect(body.value).toEqual(complex);
  });

  test('404 returns { value: null, exists: false }', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Key not found' }), { status: 404 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await getGlobalStateTool.handler(
      { namespace: 'prefs', key: 'missing' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ value: null, exists: false });
  });

  test('forwards Authorization header when authToken in state', async () => {
    let observedHeaders: Record<string, string> | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders = (init?.headers || {}) as Record<string, string>;
      return new Response(JSON.stringify({ key: 'k', value: 'v' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext({
      state: { authToken: 'pat_test_token', userId: 'user-123' } as any,
    });
    await getGlobalStateTool.handler({ namespace: 'ns', key: 'k' }, ctx);
    expect(observedHeaders?.['Authorization']).toBe('Bearer pat_test_token');
    expect(observedHeaders?.['X-User-Id']).toBe('user-123');
  });

  test('forwards X-Internal-Key when present and no authToken', async () => {
    const originalKey = process.env.INTERNAL_SERVICE_KEY;
    process.env.INTERNAL_SERVICE_KEY = 'secret-internal';
    try {
      let observedHeaders: Record<string, string> | undefined;
      globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedHeaders = (init?.headers || {}) as Record<string, string>;
        return new Response(JSON.stringify({ key: 'k', value: 'v' }), { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      const ctx = makeMockContext({ state: { userId: 'svc-user' } as any });
      await getGlobalStateTool.handler({ namespace: 'ns', key: 'k' }, ctx);
      expect(observedHeaders?.['X-Internal-Key']).toBe('secret-internal');
      expect(observedHeaders?.['X-User-Id']).toBe('svc-user');
      // No bearer when no authToken
      expect(observedHeaders?.['Authorization']).toBeUndefined();
    } finally {
      if (originalKey === undefined) delete process.env.INTERNAL_SERVICE_KEY;
      else process.env.INTERNAL_SERVICE_KEY = originalKey;
    }
  });
});

describe('get_global_state — validation errors', () => {
  test('missing namespace returns isError + VALIDATION', async () => {
    // @ts-expect-error — exercising runtime validation
    const result = await getGlobalStateTool.handler({ key: 'k' }, makeMockContext());
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/namespace is required/i);
  });

  test('whitespace-only namespace returns isError', async () => {
    const result = await getGlobalStateTool.handler(
      { namespace: '   ', key: 'k' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
  });

  test('missing key returns isError + VALIDATION', async () => {
    // @ts-expect-error — runtime validation
    const result = await getGlobalStateTool.handler({ namespace: 'ns' }, makeMockContext());
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/key is required/i);
  });
});

describe('get_global_state — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('5xx response surfaces status + error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('internal boom', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await getGlobalStateTool.handler(
      { namespace: 'ns', key: 'k' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(500);
    expect(body.error).toMatch(/500/);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED state-api');
    }) as unknown as typeof globalThis.fetch;

    const result = await getGlobalStateTool.handler(
      { namespace: 'ns', key: 'k' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });
});
