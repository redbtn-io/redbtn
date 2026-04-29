/**
 * Vitest for native tool: download_file
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * The handler ultimately fetches via the global `fetch`. We mock fetch to keep
 * the suite deterministic and offline (per the handoff brief).
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import downloadFileTool from '../../src/lib/tools/native/download-file';

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

/**
 * Build a Response whose body is delivered via a ReadableStream (the path the
 * tool actually exercises in production). Enables size-cap mid-stream tests.
 */
function streamingResponse(
  bytes: Uint8Array,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const status = init?.status ?? 200;
  const headers = new Headers(init?.headers || {});
  if (!headers.get('content-length') && status >= 200 && status < 300) {
    headers.set('content-length', String(bytes.byteLength));
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

describe('download_file — schema', () => {
  test('exposes the documented inputs per spec', () => {
    expect(downloadFileTool.description.toLowerCase()).toContain('download');
    expect(downloadFileTool.inputSchema.required).toEqual(['url']);
    expect(downloadFileTool.inputSchema.properties.url).toBeDefined();
    expect(downloadFileTool.inputSchema.properties.maxSizeBytes).toBeDefined();
    expect(downloadFileTool.server).toBe('system');
  });
});

describe('download_file — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('downloads a small text file and returns base64 + mime + size', async () => {
    const payload = Buffer.from('hello world', 'utf8');
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('https://example.com/hello.txt');
      return streamingResponse(new Uint8Array(payload), {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await downloadFileTool.handler(
      { url: 'https://example.com/hello.txt' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.contentBase64).toBe(payload.toString('base64'));
    expect(body.mimeType).toBe('text/plain');
    expect(body.size).toBe(payload.length);
    // Round-trip the base64 to confirm it decodes back to the original bytes.
    expect(Buffer.from(body.contentBase64, 'base64').toString('utf8')).toBe(
      'hello world',
    );
  });

  test('round-trips a binary payload (PNG bytes) intact', async () => {
    // Tiny synthetic "PNG" — first 8 bytes of the real PNG signature plus
    // some payload. Good enough to prove base64 round-trips binary cleanly.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0xfc,
    ]);
    globalThis.fetch = vi.fn(async () =>
      streamingResponse(new Uint8Array(png), {
        headers: { 'content-type': 'image/png' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await downloadFileTool.handler(
      { url: 'https://cdn.example.com/pic.png' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.mimeType).toBe('image/png');
    expect(body.size).toBe(png.length);
    const decoded = Buffer.from(body.contentBase64, 'base64');
    expect(Buffer.compare(decoded, png)).toBe(0);
  });

  test('falls back to URL extension when content-type is generic', async () => {
    const payload = Buffer.from('%PDF-1.4 fake', 'utf8');
    globalThis.fetch = vi.fn(async () =>
      streamingResponse(new Uint8Array(payload), {
        headers: { 'content-type': 'application/octet-stream' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await downloadFileTool.handler(
      { url: 'https://example.com/files/report.pdf' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.mimeType).toBe('application/pdf');
  });

  test("default mimeType is 'application/octet-stream' when nothing identifies it", async () => {
    const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    globalThis.fetch = vi.fn(async () =>
      // No content-type; URL has no extension either.
      streamingResponse(new Uint8Array(payload), {
        headers: {},
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await downloadFileTool.handler(
      { url: 'https://example.com/blob' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.mimeType).toBe('application/octet-stream');
  });

  test('handles fetch responses without a streamable body (arrayBuffer fallback)', async () => {
    // Some mocks / older runtimes return Response.body === null. The handler
    // falls back to arrayBuffer in that case.
    const payload = Buffer.from('fallback payload');
    globalThis.fetch = vi.fn(async () => {
      const fakeResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: null as ReadableStream<Uint8Array> | null,
        async arrayBuffer() {
          return new Uint8Array(payload).buffer;
        },
      };
      return fakeResponse as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const result = await downloadFileTool.handler(
      { url: 'https://example.com/fallback.txt' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.size).toBe(payload.length);
    expect(body.mimeType).toBe('text/plain');
  });
});

describe('download_file — size limit', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('rejects up-front when Content-Length exceeds maxSizeBytes', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('big body', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': '5000000', // 5 MB declared
        },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await downloadFileTool.handler(
      {
        url: 'https://example.com/huge.txt',
        maxSizeBytes: 1024, // 1 KB cap
      },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('TOO_LARGE');
    expect(body.maxSizeBytes).toBe(1024);
    expect(body.declaredSize).toBe(5000000);
  });

  test('aborts mid-stream when body grows past maxSizeBytes', async () => {
    // Server lies (or omits) Content-Length, then streams more than the cap.
    const big = Buffer.alloc(4096, 0x41); // 4 KB of 'A'
    globalThis.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(big.subarray(0, 1024)));
          controller.enqueue(new Uint8Array(big.subarray(1024, 2048)));
          controller.enqueue(new Uint8Array(big.subarray(2048, 4096)));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await downloadFileTool.handler(
      {
        url: 'https://example.com/sneaky.bin',
        maxSizeBytes: 2000, // smaller than the streamed total
      },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('TOO_LARGE');
    expect(body.maxSizeBytes).toBe(2000);
  });

  test('uses default 10 MB cap when maxSizeBytes omitted', async () => {
    const oneMB = Buffer.alloc(1024 * 1024, 0);
    globalThis.fetch = vi.fn(async () =>
      streamingResponse(new Uint8Array(oneMB), {
        headers: { 'content-type': 'application/octet-stream' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await downloadFileTool.handler(
      { url: 'https://example.com/normal.bin' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.size).toBe(oneMB.length);
  });
});

describe('download_file — validation errors', () => {
  test('missing url returns isError + VALIDATION', async () => {
    const result = await downloadFileTool.handler({}, makeMockContext());
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/url is required/i);
  });

  test('blank-string url returns isError + VALIDATION', async () => {
    const result = await downloadFileTool.handler(
      { url: '   ' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('VALIDATION');
  });

  test('invalid URL returns isError + VALIDATION', async () => {
    const result = await downloadFileTool.handler(
      { url: 'not a url' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/Invalid URL/);
  });

  test('non-http(s) protocol returns isError + VALIDATION', async () => {
    const ftp = await downloadFileTool.handler(
      { url: 'ftp://example.com/file' },
      makeMockContext(),
    );
    expect(ftp.isError).toBe(true);
    const body = JSON.parse(ftp.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/http:\/\/ or https:\/\//);

    const file = await downloadFileTool.handler(
      { url: 'file:///etc/passwd' },
      makeMockContext(),
    );
    expect(file.isError).toBe(true);

    const js = await downloadFileTool.handler(
      { url: 'javascript:alert(1)' },
      makeMockContext(),
    );
    expect(js.isError).toBe(true);

    const data = await downloadFileTool.handler(
      { url: 'data:text/plain;base64,aGk=' },
      makeMockContext(),
    );
    expect(data.isError).toBe(true);
  });

  test('zero or negative maxSizeBytes returns isError + VALIDATION', async () => {
    const zero = await downloadFileTool.handler(
      { url: 'https://example.com/x', maxSizeBytes: 0 },
      makeMockContext(),
    );
    expect(zero.isError).toBe(true);
    expect(JSON.parse(zero.content[0].text).code).toBe('VALIDATION');

    const neg = await downloadFileTool.handler(
      { url: 'https://example.com/x', maxSizeBytes: -1 },
      makeMockContext(),
    );
    expect(neg.isError).toBe(true);
  });
});

describe('download_file — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('non-2xx response surfaces error with status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    ) as unknown as typeof globalThis.fetch;

    const result = await downloadFileTool.handler(
      { url: 'https://example.com/missing.png' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/HTTP 404/);
    expect(body.status).toBe(404);
    expect(body.url).toBe('https://example.com/missing.png');
  });

  test('fetch rejection surfaces the error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET upstream');
    }) as unknown as typeof globalThis.fetch;

    const result = await downloadFileTool.handler(
      { url: 'https://example.com/dead.png' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/ECONNRESET/);
    expect(body.url).toBe('https://example.com/dead.png');
  });

  test('honours pre-aborted run signal without making a request', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const controller = new AbortController();
    controller.abort();

    const result = await downloadFileTool.handler(
      { url: 'https://example.com/x.png' },
      makeMockContext({ abortSignal: controller.signal }),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('ABORTED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
