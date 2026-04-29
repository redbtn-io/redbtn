/**
 * Integration test for the native web pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a
 * small graph using the new tools end-to-end."
 *
 * The redbtn graph compiler depends on MongoDB / Redis / LangGraph plumbing
 * which is not always available in CI. This test instead exercises the layer
 * a graph node actually calls when it runs a `tool` step:
 *
 *   1. The NativeToolRegistry singleton has registered both web tools.
 *   2. A simulated multi-step "graph" runs `web_search` → uses the first
 *      result URL as input to `scrape_url` → asserts the final state contains
 *      both the search hit and the scraped content.
 *
 * That mirrors `state.searchResults[0].url` style chaining seen in real
 * graph configs (e.g. data/nodes/search.json + data/nodes/browse.json) without
 * needing the LangGraph runtime.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';

// In production, native-registry.ts uses `require('./native/foo.js')` to load
// each tool from the dist directory. In a vitest run executing the TS sources
// directly, those `.js` paths don't exist next to the .ts module — the catch
// block silently swallows the failure. We work around it by importing the TS
// modules and explicitly re-registering them with the singleton, which is
// exactly what the dist-build path does at runtime.
import webSearchTool from '../../src/lib/tools/native/web-search';
import scrapeUrlTool from '../../src/lib/tools/native/scrape-url';

const FAKE_GOOGLE_KEY = 'integration-test-google-key';
const FAKE_GOOGLE_CX = 'integration-test-cse';

const FAKE_GOOGLE_RESPONSE = {
  items: [
    {
      title: 'Latest engineering update',
      link: 'https://example.org/posts/engineering',
      snippet: 'How we shipped the redbtn web pack tools.',
      pagemap: {
        metatags: [{ 'article:published_time': '2025-12-01T12:00:00Z' }],
      },
    },
    {
      title: 'Older post',
      link: 'https://example.org/posts/older',
      snippet: 'A previous post.',
    },
  ],
  searchInformation: { totalResults: '2' },
};

const FAKE_ARTICLE_HTML = `
<!DOCTYPE html>
<html>
  <head><title>Latest engineering update</title></head>
  <body>
    <article>
      <p>This is the canonical body of our engineering update. We replaced the
         MCP web server with two native tools (web_search and scrape_url) to
         remove an extra IPC hop and enable proper streaming.</p>
      <p>The native tools register through NativeToolRegistry and the universal
         tool executor prefers native dispatch when a tool name resolves both
         locally and via MCP — so existing graph configs work unchanged.</p>
      <p>This third paragraph adds enough text for the smart-extractor to score
         the article block as the dominant content region. Multiple sentences,
         realistic punctuation, and meaningful word counts all matter.</p>
    </article>
  </body>
</html>
`;

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('web pack integration — registration + chained execution', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;
  let originalCx: string | undefined;

  beforeAll(() => {
    // Re-register the web-pack tools against the singleton. In production this
    // is done by `registerBuiltinTools` via require('./native/foo.js'), which
    // doesn't fire when running TS sources under vitest (no .js sibling).
    const registry = getNativeRegistry();
    if (!registry.has('web_search')) registry.register('web_search', webSearchTool);
    if (!registry.has('scrape_url')) registry.register('scrape_url', scrapeUrlTool);
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env.GOOGLE_API_KEY;
    originalCx = process.env.GOOGLE_SEARCH_ENGINE_ID;
    process.env.GOOGLE_API_KEY = FAKE_GOOGLE_KEY;
    process.env.GOOGLE_SEARCH_ENGINE_ID = FAKE_GOOGLE_CX;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalApiKey;
    if (originalCx === undefined) delete process.env.GOOGLE_SEARCH_ENGINE_ID;
    else process.env.GOOGLE_SEARCH_ENGINE_ID = originalCx;
    vi.restoreAllMocks();
  });

  test('NativeToolRegistry has both web pack tools registered', () => {
    const registry = getNativeRegistry();
    expect(registry.has('web_search')).toBe(true);
    expect(registry.has('scrape_url')).toBe(true);

    const tools = registry.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('web_search');
    expect(names).toContain('scrape_url');

    const webSearch = tools.find((t) => t.name === 'web_search');
    const scrapeUrl = tools.find((t) => t.name === 'scrape_url');
    expect(webSearch?.server).toBe('web');
    expect(scrapeUrl?.server).toBe('web');
    expect(webSearch?.inputSchema.required).toContain('query');
    expect(scrapeUrl?.inputSchema.required).toContain('url');
  });

  test('end-to-end: web_search → scrape_url chain via registry.callTool', async () => {
    const registry = getNativeRegistry();

    // Single fetch mock that returns appropriate payloads based on URL.
    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      fetchCalls.push(u);

      if (u.includes('googleapis.com/customsearch/v1')) {
        return new Response(JSON.stringify(FAKE_GOOGLE_RESPONSE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u === 'https://example.org/posts/engineering') {
        return new Response(FAKE_ARTICLE_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    // Step 1: search via the dispatcher (this is what `tool` step type does)
    const ctx1 = makeMockContext();
    const searchResult = await registry.callTool(
      'web_search',
      { query: 'redbtn web pack release', count: 5 },
      ctx1,
    );
    expect(searchResult.isError).toBeFalsy();
    const searchBody = JSON.parse(searchResult.content[0].text);
    expect(searchBody.results).toHaveLength(2);
    expect(searchBody.results[0].url).toBe(
      'https://example.org/posts/engineering',
    );

    // Simulated graph state would now have something like:
    //   state.searchResults = searchBody.results
    // and the next tool step would template `state.searchResults[0].url` as
    // the `url` arg for scrape_url.
    const firstUrl = searchBody.results[0].url;

    // Step 2: scrape via the dispatcher
    const ctx2 = makeMockContext();
    const scrapeResult = await registry.callTool(
      'scrape_url',
      { url: firstUrl },
      ctx2,
    );
    expect(scrapeResult.isError).toBeFalsy();
    const scrapeBody = JSON.parse(scrapeResult.content[0].text);
    expect(scrapeBody.url).toBe(firstUrl);
    expect(scrapeBody.title).toBe('Latest engineering update');
    expect(scrapeBody.content).toMatch(/canonical body of our engineering/);
    expect(scrapeBody.contentLength).toBeGreaterThan(0);
    expect(scrapeBody.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Verify the dispatcher actually drove both upstream calls
    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[0]).toContain('googleapis.com/customsearch/v1');
    expect(fetchCalls[1]).toBe(firstUrl);
  });

  test('end-to-end: chain handles upstream error from scrape gracefully', async () => {
    const registry = getNativeRegistry();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.includes('googleapis.com/customsearch/v1')) {
        return new Response(JSON.stringify(FAKE_GOOGLE_RESPONSE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Article fetch fails
      return new Response('Service Unavailable', { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const searchResult = await registry.callTool(
      'web_search',
      { query: 'broken downstream' },
      ctx,
    );
    expect(searchResult.isError).toBeFalsy();
    const searchBody = JSON.parse(searchResult.content[0].text);
    const firstUrl = searchBody.results[0].url;

    const scrapeResult = await registry.callTool(
      'scrape_url',
      { url: firstUrl, format: 'html' },
      ctx,
    );
    expect(scrapeResult.isError).toBe(true);
    const scrapeBody = JSON.parse(scrapeResult.content[0].text);
    expect(scrapeBody.error).toMatch(/HTTP 503/);
    expect(scrapeBody.url).toBe(firstUrl);
  });
});
