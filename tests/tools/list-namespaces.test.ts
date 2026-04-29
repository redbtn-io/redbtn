/**
 * Vitest for native tool: list_namespaces
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * `list_namespaces` takes no inputs, so the validation-error case here
 * exercises the API rejecting the call (e.g. unauthorised) rather than a
 * client-side input check.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import listNamespacesTool from '../../src/lib/tools/native/list-namespaces';

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

describe('list_namespaces — schema', () => {
  test('takes no required inputs', () => {
    expect(listNamespacesTool.description.toLowerCase()).toMatch(/namespace/);
    expect(listNamespacesTool.inputSchema.required).toEqual([]);
  });
});

describe('list_namespaces — happy path', () => {
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

  test('maps API namespace summaries to spec shape', async () => {
    const apiPayload = {
      namespaces: [
        {
          namespaceId: 'ns_prefs_aaa',
          namespace: 'prefs',
          description: 'User prefs',
          keyCount: 4,
          lastUpdated: '2026-04-27T00:00:00Z',
          createdAt: '2025-01-01T00:00:00Z',
          isOwned: true,
        },
        {
          namespaceId: 'ns_cache_bbb',
          namespace: 'cache',
          description: '',
          keyCount: 0,
          lastUpdated: '2026-04-26T12:00:00Z',
          createdAt: '2025-06-15T00:00:00Z',
          isOwned: false,
        },
      ],
      count: 2,
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/state/namespaces');
      return new Response(JSON.stringify(apiPayload), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await listNamespacesTool.handler({}, makeMockContext());
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.namespaces).toHaveLength(2);
    expect(body.namespaces[0]).toEqual({
      name: 'prefs',
      keyCount: 4,
      lastModified: '2026-04-27T00:00:00Z',
    });
    expect(body.namespaces[1]).toEqual({
      name: 'cache',
      keyCount: 0,
      lastModified: '2026-04-26T12:00:00Z',
    });
  });

  test('returns empty array when API returns no namespaces', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ namespaces: [], count: 0 }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await listNamespacesTool.handler({}, makeMockContext());
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.namespaces).toEqual([]);
  });

  test('handles missing namespaces key in response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const result = await listNamespacesTool.handler({}, makeMockContext());
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).namespaces).toEqual([]);
  });

  test('falls back to updatedAt when lastUpdated is absent', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          namespaces: [
            {
              namespace: 'legacy',
              keyCount: 1,
              updatedAt: '2025-12-31T23:59:59Z',
            },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;
    const result = await listNamespacesTool.handler({}, makeMockContext());
    const body = JSON.parse(result.content[0].text);
    expect(body.namespaces[0]).toEqual({
      name: 'legacy',
      keyCount: 1,
      lastModified: '2025-12-31T23:59:59Z',
    });
  });
});

describe('list_namespaces — validation / upstream errors', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('401 unauthorised surfaces status (acts as our validation-error case)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        statusText: 'Unauthorized',
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await listNamespacesTool.handler({}, makeMockContext());
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(401);
    expect(body.error).toMatch(/401/);
  });

  test('500 surfaces upstream error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const result = await listNamespacesTool.handler({}, makeMockContext());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('EAI_AGAIN state-api');
    }) as unknown as typeof globalThis.fetch;

    const result = await listNamespacesTool.handler({}, makeMockContext());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/EAI_AGAIN/);
  });
});
