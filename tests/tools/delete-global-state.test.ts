/**
 * Vitest for native tool: delete_global_state
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import deleteGlobalStateTool from '../../src/lib/tools/native/delete-global-state';

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

describe('delete_global_state — schema', () => {
  test('exposes required inputs per spec', () => {
    expect(deleteGlobalStateTool.description.toLowerCase()).toMatch(/delete|namespace/);
    expect(deleteGlobalStateTool.inputSchema.required).toEqual(['namespace', 'key']);
    expect(deleteGlobalStateTool.inputSchema.properties.namespace).toBeDefined();
    expect(deleteGlobalStateTool.inputSchema.properties.key).toBeDefined();
  });
});

describe('delete_global_state — happy path', () => {
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

  test('200 returns { ok: true, existed: true }', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe(
        'http://test-webapp.example/api/v1/state/namespaces/prefs/values/color',
      );
      expect(init?.method).toBe('DELETE');
      return new Response(JSON.stringify({ success: true, message: 'Deleted' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await deleteGlobalStateTool.handler(
      { namespace: 'prefs', key: 'color' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ ok: true, existed: true });
  });

  test('404 returns { ok: true, existed: false } (idempotent delete)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Key not found' }), { status: 404 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await deleteGlobalStateTool.handler(
      { namespace: 'prefs', key: 'never-existed' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ ok: true, existed: false });
  });

  test('encodes namespace and key in URL', async () => {
    let observedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      observedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await deleteGlobalStateTool.handler(
      { namespace: 'with-dashes', key: 'k_under' },
      makeMockContext(),
    );
    // We don't assert URL-encoding behaviour for these characters specifically
    // (they're allowed as-is by encodeURIComponent), just that the values
    // appear in the URL.
    expect(observedUrl).toContain('with-dashes');
    expect(observedUrl).toContain('k_under');
  });
});

describe('delete_global_state — validation errors', () => {
  test('missing namespace returns isError + VALIDATION', async () => {
    // @ts-expect-error
    const r = await deleteGlobalStateTool.handler({ key: 'k' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing key returns isError + VALIDATION', async () => {
    // @ts-expect-error
    const r = await deleteGlobalStateTool.handler({ namespace: 'ns' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('empty-string key returns isError + VALIDATION', async () => {
    const r = await deleteGlobalStateTool.handler(
      { namespace: 'ns', key: '   ' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('delete_global_state — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 surfaces status + error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await deleteGlobalStateTool.handler(
      { namespace: 'ns', key: 'k' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(500);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET state-api');
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteGlobalStateTool.handler(
      { namespace: 'ns', key: 'k' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNRESET/);
  });
});
