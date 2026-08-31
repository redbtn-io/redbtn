import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import webSearchTool from '../../src/lib/tools/native/web-search';

function makeMockContext() {
  return {
    runId: 'test-run-123',
    nodeId: 'test-node-456',
    publisher: {
      publish: vi.fn(),
    },
  };
}

describe('web_search — DuckDuckGo provider and extractContent', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;
  let originalCx: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env.GOOGLE_API_KEY;
    originalCx = process.env.GOOGLE_SEARCH_ENGINE_ID;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_SEARCH_ENGINE_ID;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey !== undefined) process.env.GOOGLE_API_KEY = originalApiKey;
    if (originalCx !== undefined) process.env.GOOGLE_SEARCH_ENGINE_ID = originalCx;
    vi.restoreAllMocks();
  });

  test('searches via DuckDuckGo when provider is duckduckgo', async () => {
    const fakeHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="result result__body">
            <h2 class="result__title">
              <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Flangchain">LangChain Docs</a>
            </h2>
            <a class="result__snippet">Build context-aware reasoning applications with LangChain.</a>
          </div>
          <div class="result result__body">
            <h2 class="result__title">
              <a class="result__a" href="https://example.com/langgraph">LangGraph Overview</a>
            </h2>
            <a class="result__snippet">Orchestrate agent state machines easily.</a>
          </div>
        </body>
      </html>
    `;

    globalThis.fetch = vi.fn(async () => {
      return new Response(fakeHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await webSearchTool.handler(
      { query: 'langchain', provider: 'duckduckgo', count: 5 },
      ctx
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.totalResults).toBe(2);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].title).toBe('LangChain Docs');
    expect(body.results[0].url).toBe('https://example.com/langchain');
    expect(body.results[0].snippet).toContain('Build context-aware');
    expect(body.results[1].title).toBe('LangGraph Overview');
    expect(body.results[1].url).toBe('https://example.com/langgraph');
  });

  test('appends site filter to query', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response('<html><body></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    await webSearchTool.handler(
      { query: 'vitest', site: 'github.com', provider: 'duckduckgo' },
      ctx
    );

    expect(capturedUrl).toContain(encodeURIComponent('vitest site:github.com'));
  });
});
