/**
 * Vitest for native tool: list_global_state
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import listGlobalStateTool from '../../src/lib/tools/native/list-global-state';

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

describe('list_global_state — schema', () => {
  test('exposes required namespace input', () => {
    expect(listGlobalStateTool.description.toLowerCase()).toMatch(/key.value pairs|namespace/);
    expect(listGlobalStateTool.inputSchema.required).toEqual(['namespace']);
    expect(listGlobalStateTool.inputSchema.properties.namespace).toBeDefined();
  });
});

describe('list_global_state — happy path', () => {
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

  test('returns { values: {...} } from API', async () => {
    const apiPayload = {
      values: {
        color: 'red',
        count: 7,
        nested: { ok: true, tags: ['a', 'b'] },
      },
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/state/namespaces/prefs/values');
      return new Response(JSON.stringify(apiPayload), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await listGlobalStateTool.handler(
      { namespace: 'prefs' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.values).toEqual(apiPayload.values);
  });

  test('empty namespace returns { values: {} }', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ values: {} }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await listGlobalStateTool.handler(
      { namespace: 'fresh' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.values).toEqual({});
  });

  test('404 returns empty values map (matches GlobalStateClient behaviour)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Namespace not found' }), { status: 404 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await listGlobalStateTool.handler(
      { namespace: 'missing' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.values).toEqual({});
  });

  test('handles missing values key in response gracefully', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ /* no values key */ }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await listGlobalStateTool.handler(
      { namespace: 'odd' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.values).toEqual({});
  });
});

describe('list_global_state — validation errors', () => {
  test('missing namespace returns isError + VALIDATION', async () => {
    // @ts-expect-error
    const r = await listGlobalStateTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('whitespace-only namespace returns isError', async () => {
    const r = await listGlobalStateTool.handler({ namespace: '   ' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('list_global_state — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 response surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await listGlobalStateTool.handler({ namespace: 'ns' }, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(500);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('EHOSTDOWN state-api');
    }) as unknown as typeof globalThis.fetch;

    const r = await listGlobalStateTool.handler({ namespace: 'ns' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/EHOSTDOWN/);
  });
});
