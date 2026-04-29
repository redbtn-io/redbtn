/**
 * Vitest for native tool: send_webhook
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 *
 * No external mocks needed; we mock globalThis.fetch directly the same way
 * cancel-run.test.ts and tools-runs.test.ts do.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import sendWebhookTool from '../../src/lib/tools/native/send-webhook';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1' },
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('send_webhook — schema', () => {
  test('description mentions webhook + http', () => {
    expect(sendWebhookTool.description.toLowerCase()).toContain('webhook');
    expect(sendWebhookTool.description.toLowerCase()).toContain('http');
  });

  test('only url is required; method/headers/body/timeout are optional', () => {
    expect(sendWebhookTool.inputSchema.required).toEqual(['url']);
    const props = sendWebhookTool.inputSchema.properties;
    expect(props.url).toBeDefined();
    expect(props.method).toBeDefined();
    expect(props.headers).toBeDefined();
    expect(props.body).toBeDefined();
    expect(props.timeout).toBeDefined();
  });

  test('method enum matches the seven REST verbs', () => {
    const methodEnum: string[] = sendWebhookTool.inputSchema.properties.method.enum;
    expect(methodEnum.sort()).toEqual(
      ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].sort(),
    );
  });

  test('server label is system', () => {
    expect(sendWebhookTool.server).toBe('system');
  });
});

describe('send_webhook — validation', () => {
  test('missing url → VALIDATION', async () => {
    const r = await sendWebhookTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/url/i);
  });

  test('whitespace-only url → VALIDATION', async () => {
    const r = await sendWebhookTool.handler({ url: '   ' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('malformed url → VALIDATION', async () => {
    const r = await sendWebhookTool.handler(
      { url: 'not a url' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/Invalid URL/i);
  });

  test('non-http(s) protocol → VALIDATION', async () => {
    const r = await sendWebhookTool.handler(
      { url: 'ftp://example.com' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/protocol must be http or https/i);
  });

  test('invalid method → VALIDATION', async () => {
    const r = await sendWebhookTool.handler(
      { url: 'https://example.com/hook', method: 'TRACE' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/Invalid method/i);
  });
});

describe('send_webhook — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('default method=POST + JSON body + JSON content-type', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      capturedInit = init;
      return new Response(JSON.stringify({ ack: true, id: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const r = await sendWebhookTool.handler(
      {
        url: 'https://hook.example/notify',
        body: { event: 'order.created', orderId: 'ord_123' },
      },
      makeMockContext(),
    );

    expect(capturedUrl).toBe('https://hook.example/notify');
    expect(capturedInit?.method).toBe('POST');
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(capturedInit?.body).toBe(
      JSON.stringify({ event: 'order.created', orderId: 'ord_123' }),
    );

    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(200);
    expect(body.statusText).toBe('');
    expect(body.url).toBe('https://hook.example/notify');
    expect(body.method).toBe('POST');
    // JSON response body parses into an object.
    expect(body.response).toEqual({ ack: true, id: 42 });
  });

  test('non-JSON response body returned as a string', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('plain text ok', { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await sendWebhookTool.handler(
      { url: 'https://hook.example/x', body: { hi: true } },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.response).toBe('plain text ok');
  });

  test('GET request omits body + Content-Type', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedInit = init;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await sendWebhookTool.handler(
      { url: 'https://hook.example/poll', method: 'GET' },
      makeMockContext(),
    );
    expect(capturedInit?.method).toBe('GET');
    expect(capturedInit?.body).toBeUndefined();
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
  });

  test('string body that looks like JSON gets application/json content-type', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedInit = init;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await sendWebhookTool.handler(
      { url: 'https://h.example/x', body: '{"a":1}' },
      makeMockContext(),
    );
    expect(capturedInit?.body).toBe('{"a":1}');
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('plain string body gets text/plain content-type', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedInit = init;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await sendWebhookTool.handler(
      { url: 'https://h.example/x', body: 'just words' },
      makeMockContext(),
    );
    expect(capturedInit?.body).toBe('just words');
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBe('text/plain; charset=utf-8');
  });

  test('caller-supplied Content-Type is preserved (case-insensitive)', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedInit = init;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await sendWebhookTool.handler(
      {
        url: 'https://h.example/x',
        body: { v: 1 },
        headers: { 'content-type': 'application/vnd.api+json' },
      },
      makeMockContext(),
    );
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    // Only the lowercase variant set by the caller; we did NOT add a second one.
    expect(headers['content-type']).toBe('application/vnd.api+json');
    expect(headers['Content-Type']).toBeUndefined();
  });

  test('caller-supplied custom headers are forwarded', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedInit = init;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await sendWebhookTool.handler(
      {
        url: 'https://h.example/x',
        body: { v: 1 },
        headers: { 'X-Signature': 'abc123', 'Authorization': 'Bearer tok' },
      },
      makeMockContext(),
    );
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Signature']).toBe('abc123');
    expect(headers['Authorization']).toBe('Bearer tok');
  });

  test('PATCH method works', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedInit = init;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await sendWebhookTool.handler(
      { url: 'https://h.example/x', method: 'patch', body: { v: 1 } },
      makeMockContext(),
    );
    expect(capturedInit?.method).toBe('PATCH');
  });

  test('truncates response bodies > 100KB', async () => {
    const huge = 'x'.repeat(150_000);
    globalThis.fetch = vi.fn(async () =>
      new Response(huge, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await sendWebhookTool.handler(
      { url: 'https://h.example/x', method: 'GET' },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.truncated).toBe(true);
    expect(typeof body.response).toBe('string');
    expect((body.response as string).length).toBe(100_000);
  });
});

describe('send_webhook — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 surfaces isError + status + response body still included', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await sendWebhookTool.handler(
      { url: 'https://h.example/x', body: { v: 1 } },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(500);
    expect(body.statusText).toBe('Internal Server Error');
    expect(body.response).toEqual({ error: 'boom' });
    expect(body.error).toMatch(/Webhook returned 500/);
  });

  test('404 surfaces isError', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await sendWebhookTool.handler(
      { url: 'https://h.example/missing', method: 'GET' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(404);
  });

  test('fetch rejection surfaces error with url + method', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const r = await sendWebhookTool.handler(
      { url: 'https://h.example/x', body: { v: 1 } },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toMatch(/ECONNREFUSED/);
    expect(body.url).toBe('https://h.example/x');
    expect(body.method).toBe('POST');
  });

  test('unserialisable body → VALIDATION (circular ref)', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const r = await sendWebhookTool.handler(
      { url: 'https://h.example/x', body: circular },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/could not be serialised/i);
  });

  test('pre-aborted run signal short-circuits before fetch', async () => {
    const ac = new AbortController();
    ac.abort();
    let fetchCalled = false;
    globalThis.fetch = vi.fn(async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const r = await sendWebhookTool.handler(
      { url: 'https://h.example/x', body: { v: 1 } },
      makeMockContext({ abortSignal: ac.signal }),
    );
    expect(fetchCalled).toBe(false);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/aborted before send/);
  });

  test('timeout fires → "timed out after Xms" error', async () => {
    // fetch that respects the abort signal and rejects with AbortError when aborted.
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          if (sig.aborted) {
            const e: Error & { name: string } = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          sig.addEventListener('abort', () => {
            const e: Error & { name: string } = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          }, { once: true });
        }
        // Otherwise hang forever.
      });
    }) as unknown as typeof globalThis.fetch;

    const r = await sendWebhookTool.handler(
      { url: 'https://h.example/slow', timeout: 50, body: { v: 1 } },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/timed out after 50ms/);
  });

  test('mid-flight run abort → "aborted by caller" error', async () => {
    const ac = new AbortController();
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          sig.addEventListener('abort', () => {
            const e: Error & { name: string } = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          }, { once: true });
        }
      });
    }) as unknown as typeof globalThis.fetch;

    // Trigger run abort after 25ms so the in-flight fetch is interrupted.
    setTimeout(() => ac.abort(), 25);
    const r = await sendWebhookTool.handler(
      { url: 'https://h.example/slow', body: { v: 1 } },
      makeMockContext({ abortSignal: ac.signal }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/aborted by caller/);
  });
});
