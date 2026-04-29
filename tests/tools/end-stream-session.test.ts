/**
 * Vitest for native tool: end_stream_session
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import endStreamSessionTool from '../../src/lib/tools/native/end-stream-session';

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

describe('end_stream_session — schema', () => {
  test('requires sessionId only', () => {
    expect(endStreamSessionTool.description.toLowerCase()).toContain('session');
    expect(endStreamSessionTool.inputSchema.required).toEqual(['sessionId']);
    expect(endStreamSessionTool.inputSchema.properties.sessionId).toBeDefined();
  });

  test('server is "stream"', () => {
    expect(endStreamSessionTool.server).toBe('stream');
  });
});

describe('end_stream_session — validation', () => {
  test('missing sessionId returns isError + VALIDATION', async () => {
    const r = await endStreamSessionTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/sessionId/);
  });

  test('whitespace-only sessionId returns isError', async () => {
    const r = await endStreamSessionTool.handler(
      { sessionId: '   ' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('end_stream_session — happy path', () => {
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

  test('returns { ok: true, finalStatus: "draining" } on 200', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe(
        'http://test-webapp.example/api/v1/streams/sessions/sess-abc/end',
      );
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({
          success: true,
          session: {
            sessionId: 'sess-abc',
            streamId: 'stream-x',
            status: 'draining',
            endRequestedBy: 'client',
            updatedAt: new Date().toISOString(),
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await endStreamSessionTool.handler(
      { sessionId: 'sess-abc' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.finalStatus).toBe('draining');
    expect(body.sessionId).toBe('sess-abc');
  });

  test('idempotent draining response — already-draining session', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          message: 'Session is already draining',
          session: {
            sessionId: 'sess-already',
            streamId: 'stream-x',
            status: 'draining',
            endRequestedBy: 'client',
            updatedAt: new Date().toISOString(),
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const result = await endStreamSessionTool.handler(
      { sessionId: 'sess-already' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).finalStatus).toBe('draining');
  });

  test('encodes sessionId in URL', async () => {
    let captured = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      captured = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({ session: { sessionId: 'x', status: 'draining' } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await endStreamSessionTool.handler(
      { sessionId: 'has spaces & ?' },
      makeMockContext(),
    );
    expect(captured).toContain(encodeURIComponent('has spaces & ?'));
  });

  test('forwards bearer + user-id headers', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({ session: { sessionId: 's', status: 'draining' } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await endStreamSessionTool.handler(
      { sessionId: 's' },
      makeMockContext({ state: { authToken: 'tok-z', userId: 'user-y' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-z');
    expect(capturedHeaders['X-User-Id']).toBe('user-y');
  });

  test('falls back to "draining" when API omits status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ session: { sessionId: 's' } }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await endStreamSessionTool.handler(
      { sessionId: 's' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).finalStatus).toBe('draining');
  });
});

describe('end_stream_session — terminal session (409)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('409 already terminal returns isError + SESSION_TERMINAL code', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Session is already ended and cannot be ended.',
            type: 'invalid_request_error',
            code: 'session_terminal',
          },
        }),
        { status: 409 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await endStreamSessionTool.handler(
      { sessionId: 'sess-done' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('SESSION_TERMINAL');
    expect(body.status).toBe(409);
    expect(body.sessionId).toBe('sess-done');
    expect(body.error).toMatch(/already/i);
  });

  test('SESSION_TERMINAL surfaces a default message when API body is broken', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('not even json', { status: 409 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await endStreamSessionTool.handler(
      { sessionId: 'sess-done' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('SESSION_TERMINAL');
  });
});

describe('end_stream_session — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('404 returns isError with status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Session not found' } }), {
        status: 404,
        statusText: 'Not Found',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await endStreamSessionTool.handler(
      { sessionId: 'phantom' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(404);
    expect(body.sessionId).toBe('phantom');
  });

  test('500 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await endStreamSessionTool.handler(
      { sessionId: 's1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ETIMEDOUT webapp');
    }) as unknown as typeof globalThis.fetch;

    const r = await endStreamSessionTool.handler(
      { sessionId: 's1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ETIMEDOUT/);
  });
});
