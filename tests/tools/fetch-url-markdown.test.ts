import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import fetchUrlTool from '../../src/lib/tools/native/fetch-url';

function makeMockContext() {
  return {
    runId: 'test-run-123',
    nodeId: 'test-node-456',
    publisher: {
      publish: vi.fn(),
    },
  };
}

describe('fetch_url — HTML to Markdown and format options', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('auto format converts HTML to structured Markdown with title', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Page Title</title></head>
        <body>
          <header><nav>Nav links</nav></header>
          <article>
            <h1>Heading 1</h1>
            <p>This is a paragraph with <b>bold text</b> and <a href="https://example.com/docs">a link</a>.</p>
            <pre><code class="language-typescript">const x = 10;</code></pre>
            <ul>
              <li>Item 1</li>
              <li>Item 2</li>
            </ul>
          </article>
          <footer>Footer text</footer>
        </body>
      </html>
    `;

    globalThis.fetch = vi.fn(async () => {
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await fetchUrlTool.handler({ url: 'https://example.com' }, ctx);

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(200);
    expect(body.title).toBe('Test Page Title');
    expect(body.body).toContain('# Heading 1');
    expect(body.body).toContain('**bold text**');
    expect(body.body).toContain('[a link](https://example.com/docs)');
    expect(body.body).toContain('```typescript');
    expect(body.body).toContain('const x = 10;');
    expect(body.body).toContain('* Item 1');
    // Header & footer should be stripped
    expect(body.body).not.toContain('Nav links');
    expect(body.body).not.toContain('Footer text');
  });

  test('raw format returns unmodified HTML payload', async () => {
    const rawHtml = '<html><body><h1>Hello Raw</h1></body></html>';
    globalThis.fetch = vi.fn(async () => {
      return new Response(rawHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await fetchUrlTool.handler(
      { url: 'https://example.com', format: 'raw' },
      ctx
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.body).toBe(rawHtml);
  });

  test('JSON response is parsed and formatted', async () => {
    const data = { user: 'george', status: 'active' };
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await fetchUrlTool.handler({ url: 'https://api.example.com/data' }, ctx);

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.body).toContain('"user": "george"');
  });
});
