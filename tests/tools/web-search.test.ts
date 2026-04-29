/**
 * Vitest for native tool: web_search
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * The handler talks to Google Custom Search via global `fetch`. We mock fetch
 * to make these tests offline / deterministic.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import webSearchTool from '../../src/lib/tools/native/web-search';

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

const FAKE_API_KEY = 'fake-key-web-search-test';
const FAKE_CX = 'fake-cse-id';

describe('web_search — schema', () => {
  test('exposes required and optional inputs per spec', () => {
    expect(webSearchTool.description.toLowerCase()).toContain('search the web');
    expect(webSearchTool.inputSchema.required).toContain('query');
    expect(webSearchTool.inputSchema.properties.query).toBeDefined();
    expect(webSearchTool.inputSchema.properties.count).toBeDefined();
    expect(webSearchTool.inputSchema.properties.queryPlan).toBeDefined();
  });
});

describe('web_search — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;
  let originalCx: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env.GOOGLE_API_KEY;
    originalCx = process.env.GOOGLE_SEARCH_ENGINE_ID;
    process.env.GOOGLE_API_KEY = FAKE_API_KEY;
    process.env.GOOGLE_SEARCH_ENGINE_ID = FAKE_CX;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalApiKey;
    if (originalCx === undefined) delete process.env.GOOGLE_SEARCH_ENGINE_ID;
    else process.env.GOOGLE_SEARCH_ENGINE_ID = originalCx;
    vi.restoreAllMocks();
  });

  test('returns normalised results and totalResults', async () => {
    const fakeResponse = {
      items: [
        {
          title: 'Result 1',
          link: 'https://example.com/1',
          snippet: 'First result snippet',
          pagemap: {
            metatags: [{ 'article:published_time': '2024-01-01T00:00:00Z' }],
          },
        },
        {
          title: 'Result 2',
          link: 'https://example.com/2',
          snippet: 'Second result snippet',
        },
      ],
      searchInformation: { totalResults: '42' },
    };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      // Confirm the URL we built points at Google CSE with our query
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('googleapis.com/customsearch/v1');
      expect(u).toContain(`key=${encodeURIComponent(FAKE_API_KEY)}`);
      expect(u).toContain(`cx=${encodeURIComponent(FAKE_CX)}`);
      expect(u).toMatch(/q=test%20query/);
      return new Response(JSON.stringify(fakeResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await webSearchTool.handler(
      { query: 'test query', count: 5 },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.totalResults).toBe(42);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      title: 'Result 1',
      url: 'https://example.com/1',
      snippet: 'First result snippet',
      publishedAt: '2024-01-01T00:00:00Z',
    });
    expect(body.results[1]).toMatchObject({
      title: 'Result 2',
      url: 'https://example.com/2',
      snippet: 'Second result snippet',
    });
    // Result 2 has no metatags — should not have publishedAt
    expect(body.results[1].publishedAt).toBeUndefined();
  });

  test('clamps count to max 50', async () => {
    // Stub fetch to always return one item so we can observe page count
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(
        JSON.stringify({
          items: Array(10).fill(0).map((_, i) => ({
            title: `t${calls}-${i}`,
            link: `https://x.example/${calls}/${i}`,
            snippet: `s${calls}-${i}`,
          })),
          searchInformation: { totalResults: '500' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await webSearchTool.handler(
      { query: 'paging', count: 9999 }, // way over max
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    // Should have paged 5 times (50 results / 10 per page)
    expect(calls).toBe(5);
    expect(body.results).toHaveLength(50);
  });

  test('default count is 10 when omitted', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls++;
      const u = typeof input === 'string' ? input : (input as URL).toString();
      // Default count → single page of 10
      expect(u).toContain('num=10');
      return new Response(
        JSON.stringify({
          items: Array(10).fill(0).map((_, i) => ({
            title: `t${i}`,
            link: `https://x/${i}`,
            snippet: 's',
          })),
          searchInformation: { totalResults: '10' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await webSearchTool.handler({ query: 'default-count' }, ctx);
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.results).toHaveLength(10);
    expect(calls).toBe(1);
  });
});

describe('web_search — validation errors', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;
  let originalCx: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env.GOOGLE_API_KEY;
    originalCx = process.env.GOOGLE_SEARCH_ENGINE_ID;
    // Configure creds so validation errors aren't masked by config errors
    process.env.GOOGLE_API_KEY = FAKE_API_KEY;
    process.env.GOOGLE_SEARCH_ENGINE_ID = FAKE_CX;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalApiKey;
    if (originalCx === undefined) delete process.env.GOOGLE_SEARCH_ENGINE_ID;
    else process.env.GOOGLE_SEARCH_ENGINE_ID = originalCx;
  });

  test('empty query returns isError', async () => {
    const ctx = makeMockContext();
    const result = await webSearchTool.handler({ query: '' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/query is required/i);
    expect(body.code).toBe('VALIDATION');
  });

  test('whitespace-only query returns isError', async () => {
    const ctx = makeMockContext();
    const result = await webSearchTool.handler({ query: '   \t\n ' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
  });

  test('missing query returns isError', async () => {
    const ctx = makeMockContext();
    // @ts-expect-error — exercising the runtime validation
    const result = await webSearchTool.handler({}, ctx);
    expect(result.isError).toBe(true);
  });

  test('missing credentials returns CONFIGURATION error', async () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_SEARCH_ENGINE_ID;
    const ctx = makeMockContext();
    const result = await webSearchTool.handler({ query: 'anything' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('CONFIGURATION');
    expect(body.error).toMatch(/credentials/i);
  });
});

describe('web_search — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;
  let originalCx: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env.GOOGLE_API_KEY;
    originalCx = process.env.GOOGLE_SEARCH_ENGINE_ID;
    process.env.GOOGLE_API_KEY = FAKE_API_KEY;
    process.env.GOOGLE_SEARCH_ENGINE_ID = FAKE_CX;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalApiKey;
    if (originalCx === undefined) delete process.env.GOOGLE_SEARCH_ENGINE_ID;
    else process.env.GOOGLE_SEARCH_ENGINE_ID = originalCx;
    vi.restoreAllMocks();
  });

  test('non-2xx response surfaces status in result body', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { message: 'quotaExceeded' } }),
        { status: 429, statusText: 'Too Many Requests' },
      ),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await webSearchTool.handler({ query: 'over-quota' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/429/);
    expect(body.status).toBe(429);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED google');
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await webSearchTool.handler({ query: 'connection-fail' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });
});
