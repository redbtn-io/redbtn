/**
 * Vitest for native tool: scrape_url
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * The handler ultimately fetches HTML via the global `fetch` (either directly
 * for `format: 'html'`, or via `fetchAndParse` for markdown/text). We mock
 * fetch to keep the suite deterministic and offline.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import scrapeUrlTool from '../../src/lib/tools/native/scrape-url';

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

const FAKE_HTML = `
<!DOCTYPE html>
<html>
  <head><title>Sample Article Title</title></head>
  <body>
    <nav class="nav">irrelevant nav links</nav>
    <article>
      <p>This is the first paragraph of the main article content. It has enough text to score reasonably high in the extractor's heuristics, including periods and several words to make it look like real prose.</p>
      <p>Here is a second paragraph to ensure we have multiple paragraphs and a high-enough text length for the heuristic scoring to pick this article block as the main content.</p>
      <p>And a third paragraph that further inflates the text length, with sentences and punctuation that should help the scorer prefer this block.</p>
    </article>
    <footer>copyright 2025</footer>
  </body>
</html>
`;

describe('scrape_url — schema', () => {
  test('exposes required and optional inputs per spec', () => {
    expect(scrapeUrlTool.description.toLowerCase()).toContain('fetch a url');
    expect(scrapeUrlTool.inputSchema.required).toContain('url');
    expect(scrapeUrlTool.inputSchema.properties.url).toBeDefined();
    expect(scrapeUrlTool.inputSchema.properties.format).toBeDefined();
    expect(scrapeUrlTool.inputSchema.properties.format.enum).toEqual([
      'markdown',
      'text',
      'html',
    ]);
    expect(scrapeUrlTool.inputSchema.properties.timeout).toBeDefined();
    expect(scrapeUrlTool.inputSchema.properties.timeout.maximum).toBe(120000);
  });
});

describe('scrape_url — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('default format markdown returns extracted main text + metadata', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('https://example.com/article');
      return new Response(FAKE_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await scrapeUrlTool.handler(
      { url: 'https://example.com/article' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.url).toBe('https://example.com/article');
    expect(body.title).toBe('Sample Article Title');
    expect(typeof body.content).toBe('string');
    expect(body.content.length).toBeGreaterThan(0);
    expect(body.contentLength).toBe(body.content.length);
    expect(body.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
    // Should pull through actual paragraph text from the article
    expect(body.content).toMatch(/first paragraph of the main article/);
  });

  test("format: 'html' returns raw HTML", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(FAKE_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await scrapeUrlTool.handler(
      { url: 'https://example.com/raw', format: 'html' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.title).toBe('Sample Article Title');
    expect(body.content).toContain('<article>');
    expect(body.content).toContain('<footer>');
    expect(body.contentLength).toBe(body.content.length);
  });

  test("format: 'text' returns extracted text (same path as markdown today)", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(FAKE_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await scrapeUrlTool.handler(
      { url: 'https://example.com/text', format: 'text' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.content).toMatch(/first paragraph of the main article/);
    // Should NOT contain raw html tags
    expect(body.content).not.toContain('<article>');
  });

  test('respects custom timeout (uppercased to MAX_TIMEOUT_MS=120000)', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(FAKE_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    // Send way over max — should be clamped not rejected
    const result = await scrapeUrlTool.handler(
      { url: 'https://example.com/big', format: 'html', timeout: 999_999_999 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });
});

describe('scrape_url — validation errors', () => {
  test('missing url returns isError', async () => {
    const ctx = makeMockContext();
    // @ts-expect-error — runtime validation
    const result = await scrapeUrlTool.handler({}, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/url is required/i);
    expect(body.code).toBe('VALIDATION');
  });

  test('empty string url returns isError', async () => {
    const ctx = makeMockContext();
    const result = await scrapeUrlTool.handler({ url: '   ' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
  });

  test('non-http URL returns isError', async () => {
    const ctx = makeMockContext();
    const result = await scrapeUrlTool.handler(
      { url: 'ftp://example.com/file' },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/http:\/\/ or https:\/\//);
    expect(body.code).toBe('VALIDATION');
    expect(body.url).toBe('ftp://example.com/file');
  });

  test('javascript: URL returns isError', async () => {
    const ctx = makeMockContext();
    const result = await scrapeUrlTool.handler(
      { url: 'javascript:alert(1)' },
      ctx,
    );
    expect(result.isError).toBe(true);
  });
});

describe('scrape_url — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('non-2xx response surfaces error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await scrapeUrlTool.handler(
      { url: 'https://example.com/missing', format: 'html' },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/HTTP 404/);
    expect(body.url).toBe('https://example.com/missing');
  });

  test('non-html content-type returns error in markdown path', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"hello":"world"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await scrapeUrlTool.handler(
      { url: 'https://example.com/api.json' },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/not HTML/i);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET upstream');
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await scrapeUrlTool.handler(
      { url: 'https://example.com/dead' },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/ECONNRESET/);
  });
});
