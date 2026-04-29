/**
 * Vitest for native tool: delete_namespace
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * Implementation does a preflight GET to count keys, then DELETE. The mocks
 * here have to handle both calls.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import deleteNamespaceTool from '../../src/lib/tools/native/delete-namespace';

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

describe('delete_namespace — schema', () => {
  test('exposes required namespace input', () => {
    expect(deleteNamespaceTool.description.toLowerCase()).toMatch(/delete|namespace/);
    expect(deleteNamespaceTool.inputSchema.required).toEqual(['namespace']);
    expect(deleteNamespaceTool.inputSchema.properties.namespace).toBeDefined();
  });
});

describe('delete_namespace — happy path', () => {
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

  test('returns { ok: true, deletedKeys: N } using preflight key count', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe(
        'http://test-webapp.example/api/v1/state/namespaces/cleanup',
      );
      if (calls === 1) {
        // Preflight GET
        expect(init?.method).toBeUndefined();
        return new Response(
          JSON.stringify({ namespace: 'cleanup', keyCount: 5, entries: [] }),
          { status: 200 },
        );
      }
      // Actual DELETE
      expect(init?.method).toBe('DELETE');
      return new Response(JSON.stringify({ success: true, message: 'Deleted' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await deleteNamespaceTool.handler(
      { namespace: 'cleanup' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ ok: true, deletedKeys: 5 });
    expect(calls).toBe(2);
  });

  test('preflight 404 returns { ok: true, deletedKeys: 0 } without DELETE', async () => {
    let deleteCalled = false;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleteCalled = true;
        return new Response('should not happen', { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const result = await deleteNamespaceTool.handler(
      { namespace: 'never-existed' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ ok: true, deletedKeys: 0 });
    expect(deleteCalled).toBe(false);
  });

  test('handles 0-key namespace correctly', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ namespace: 'empty', keyCount: 0, entries: [] }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await deleteNamespaceTool.handler(
      { namespace: 'empty' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, deletedKeys: 0 });
  });

  test('race: namespace deleted between preflight and DELETE returns deletedKeys: 0', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        // Someone else got there first
        return new Response(JSON.stringify({ error: 'Namespace not found' }), { status: 404 });
      }
      return new Response(
        JSON.stringify({ namespace: 'racy', keyCount: 7, entries: [] }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await deleteNamespaceTool.handler(
      { namespace: 'racy' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, deletedKeys: 0 });
  });
});

describe('delete_namespace — validation errors', () => {
  test('missing namespace returns isError + VALIDATION', async () => {
    // @ts-expect-error
    const r = await deleteNamespaceTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('whitespace-only namespace returns isError', async () => {
    const r = await deleteNamespaceTool.handler({ namespace: '   ' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('delete_namespace — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('preflight 403 forbidden surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await deleteNamespaceTool.handler(
      { namespace: 'shared-ns' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(403);
  });

  test('DELETE returning non-2xx (non-404) surfaces error', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
      }
      return new Response(
        JSON.stringify({ namespace: 'half-broken', keyCount: 3, entries: [] }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await deleteNamespaceTool.handler(
      { namespace: 'half-broken' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(500);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNABORTED state-api');
    }) as unknown as typeof globalThis.fetch;

    const result = await deleteNamespaceTool.handler(
      { namespace: 'ns' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/ECONNABORTED/);
  });
});
