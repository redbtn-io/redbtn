/**
 * Vitest for native tool: set_global_state
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import setGlobalStateTool from '../../src/lib/tools/native/set-global-state';

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

describe('set_global_state — schema', () => {
  test('exposes required and optional inputs per spec', () => {
    expect(setGlobalStateTool.description.toLowerCase()).toMatch(/global-state|namespace/);
    expect(setGlobalStateTool.inputSchema.required).toEqual(['namespace', 'key', 'value']);
    expect(setGlobalStateTool.inputSchema.properties.namespace).toBeDefined();
    expect(setGlobalStateTool.inputSchema.properties.key).toBeDefined();
    expect(setGlobalStateTool.inputSchema.properties.value).toBeDefined();
    expect(setGlobalStateTool.inputSchema.properties.description).toBeDefined();
    expect(setGlobalStateTool.inputSchema.properties.ttlSeconds).toBeDefined();
  });
});

describe('set_global_state — happy path', () => {
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

  test('returns { ok: true } on 200 OK', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe(
        'http://test-webapp.example/api/v1/state/namespaces/prefs/values',
      );
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.key).toBe('color');
      expect(body.value).toBe('blue');
      return new Response(
        JSON.stringify({ success: true, key: 'color', namespace: 'prefs' }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await setGlobalStateTool.handler(
      { namespace: 'prefs', key: 'color', value: 'blue' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ ok: true });
  });

  test('forwards description and ttlSeconds in request body', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await setGlobalStateTool.handler(
      {
        namespace: 'cache',
        key: 'lookup',
        value: { count: 7 },
        description: 'Hit count from last run',
        ttlSeconds: 3600,
      },
      makeMockContext(),
    );
    expect(captured.description).toBe('Hit count from last run');
    expect(captured.ttlSeconds).toBe(3600);
    expect(captured.value).toEqual({ count: 7 });
  });

  test('accepts arbitrary JSON value types', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    // Number
    await setGlobalStateTool.handler(
      { namespace: 'ns', key: 'count', value: 42 },
      makeMockContext(),
    );
    expect(captured.value).toBe(42);

    // Boolean
    await setGlobalStateTool.handler(
      { namespace: 'ns', key: 'on', value: false },
      makeMockContext(),
    );
    expect(captured.value).toBe(false);

    // Array
    await setGlobalStateTool.handler(
      { namespace: 'ns', key: 'tags', value: ['a', 'b'] },
      makeMockContext(),
    );
    expect(captured.value).toEqual(['a', 'b']);

    // Null (explicit)
    await setGlobalStateTool.handler(
      { namespace: 'ns', key: 'maybe', value: null },
      makeMockContext(),
    );
    expect(captured.value).toBeNull();
  });

  test('clamps ttlSeconds to >= 1 when given a fractional value', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    // 0.4 → max(1, floor(0.4)) = 1
    await setGlobalStateTool.handler(
      { namespace: 'ns', key: 'k', value: 'v', ttlSeconds: 0.4 },
      makeMockContext(),
    );
    expect(captured.ttlSeconds).toBe(1);

    // 7.9 → max(1, floor(7.9)) = 7
    await setGlobalStateTool.handler(
      { namespace: 'ns', key: 'k', value: 'v', ttlSeconds: 7.9 },
      makeMockContext(),
    );
    expect(captured.ttlSeconds).toBe(7);
  });
});

describe('set_global_state — validation errors', () => {
  test('missing namespace returns isError + VALIDATION', async () => {
    // @ts-expect-error
    const r = await setGlobalStateTool.handler({ key: 'k', value: 'v' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing key returns isError + VALIDATION', async () => {
    // @ts-expect-error
    const r = await setGlobalStateTool.handler(
      { namespace: 'ns', value: 'v' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing value returns isError + VALIDATION', async () => {
    const r = await setGlobalStateTool.handler(
      { namespace: 'ns', key: 'k' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/value is required/i);
  });

  test('explicit null value is allowed (not undefined)', async () => {
    process.env.WEBAPP_URL = 'http://test-webapp.example';
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const r = await setGlobalStateTool.handler(
      { namespace: 'ns', key: 'k', value: null },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
  });
});

describe('set_global_state — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('403 forbidden surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await setGlobalStateTool.handler(
      { namespace: 'ns', key: 'k', value: 'v' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(403);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENETUNREACH state-api');
    }) as unknown as typeof globalThis.fetch;

    const r = await setGlobalStateTool.handler(
      { namespace: 'ns', key: 'k', value: 'v' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toMatch(/ENETUNREACH/);
  });
});
