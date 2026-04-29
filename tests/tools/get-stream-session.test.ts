/**
 * Vitest for native tool: get_stream_session
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * The tool has two execution paths:
 *  - fast path: caller passed a streamId hint → single GET against
 *    /api/v1/streams/:streamId/sessions/:sessionId.
 *  - discovery walk: no hint → list streams, then probe each one's
 *    /sessions/:sessionId endpoint until found.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getStreamSessionTool from '../../src/lib/tools/native/get-stream-session';

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

describe('get_stream_session — schema', () => {
  test('requires sessionId; streamId is optional fast-path hint', () => {
    expect(getStreamSessionTool.description.toLowerCase()).toContain('session');
    expect(getStreamSessionTool.inputSchema.required).toEqual(['sessionId']);
    expect(getStreamSessionTool.inputSchema.properties.sessionId).toBeDefined();
    expect(getStreamSessionTool.inputSchema.properties.streamId).toBeDefined();
  });

  test('server is "stream"', () => {
    expect(getStreamSessionTool.server).toBe('stream');
  });
});

describe('get_stream_session — validation', () => {
  test('missing sessionId returns isError + VALIDATION', async () => {
    const r = await getStreamSessionTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/sessionId/);
  });

  test('whitespace-only sessionId returns isError', async () => {
    const r = await getStreamSessionTool.handler(
      { sessionId: '   ' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('get_stream_session — fast path (streamId hint)', () => {
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

  test('returns full session doc unwrapped from { session: ... }', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe(
        'http://test-webapp.example/api/v1/streams/stream-x/sessions/sess-abc',
      );
      return new Response(
        JSON.stringify({
          success: true,
          session: {
            sessionId: 'sess-abc',
            streamId: 'stream-x',
            userId: 'user-1',
            status: 'active',
            triggeredBy: 'api',
            startedAt: new Date().toISOString(),
            turnCount: 3,
            runIds: ['r1', 'r2'],
            logs: [{ timestamp: new Date().toISOString(), level: 'info', message: 'ok' }],
            isKeepAlive: false,
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await getStreamSessionTool.handler(
      { sessionId: 'sess-abc', streamId: 'stream-x' },
      makeMockContext(),
    );
    expect(calls).toBe(1); // ← fast path: single fetch
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.session.sessionId).toBe('sess-abc');
    expect(body.session.streamId).toBe('stream-x');
    expect(body.session.status).toBe('active');
    expect(body.session.runIds).toEqual(['r1', 'r2']);
    expect(body.session.logs).toBeDefined();
  });

  test('encodes both ids in URL', async () => {
    let captured = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      captured = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({ session: { sessionId: 's', streamId: 'x' } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await getStreamSessionTool.handler(
      { sessionId: 'has spaces & ?', streamId: 'has spaces' },
      makeMockContext(),
    );
    expect(captured).toContain(encodeURIComponent('has spaces & ?'));
    expect(captured).toContain(encodeURIComponent('has spaces'));
  });

  test('404 surfaces session_not_found', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Session not found' } }), {
        status: 404,
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getStreamSessionTool.handler(
      { sessionId: 'phantom', streamId: 'stream-x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toBe('session_not_found');
    expect(body.sessionId).toBe('phantom');
  });
});

describe('get_stream_session — discovery walk (no streamId hint)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('walks streams list and finds session in second stream', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      calls.push(u);

      if (u.endsWith('/api/v1/streams?limit=100')) {
        return new Response(
          JSON.stringify({
            streams: [
              { streamId: 'stream-a', name: 'A' },
              { streamId: 'stream-b', name: 'B' },
              { streamId: 'stream-c', name: 'C' },
            ],
          }),
          { status: 200 },
        );
      }
      if (u.includes('/streams/stream-a/sessions/sess-target')) {
        return new Response(JSON.stringify({}), { status: 404 });
      }
      if (u.includes('/streams/stream-b/sessions/sess-target')) {
        return new Response(
          JSON.stringify({
            session: {
              sessionId: 'sess-target',
              streamId: 'stream-b',
              status: 'active',
            },
          }),
          { status: 200 },
        );
      }
      // Should not reach stream-c if the walk short-circuits on first hit
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const result = await getStreamSessionTool.handler(
      { sessionId: 'sess-target' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.session.sessionId).toBe('sess-target');
    expect(body.session.streamId).toBe('stream-b');

    // Confirm the search short-circuited (no probe of stream-c)
    expect(calls.some((c) => c.includes('stream-c'))).toBe(false);
  });

  test('returns session_not_found when walk exhausts every stream', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.endsWith('/api/v1/streams?limit=100')) {
        return new Response(
          JSON.stringify({ streams: [{ streamId: 'stream-a' }, { streamId: 'stream-b' }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const r = await getStreamSessionTool.handler(
      { sessionId: 'nope' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe('session_not_found');
  });

  test('per-stream errors do not abort the walk', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.endsWith('/api/v1/streams?limit=100')) {
        return new Response(
          JSON.stringify({ streams: [{ streamId: 'flaky' }, { streamId: 'good' }] }),
          { status: 200 },
        );
      }
      if (u.includes('/streams/flaky/')) {
        // Simulate transient ACL flip / 5xx
        return new Response('flaky', { status: 503 });
      }
      if (u.includes('/streams/good/')) {
        return new Response(
          JSON.stringify({
            session: { sessionId: 'sess-x', streamId: 'good', status: 'ended' },
          }),
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const r = await getStreamSessionTool.handler(
      { sessionId: 'sess-x' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.session.streamId).toBe('good');
  });

  test('streams-list 500 surfaces as upstream error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getStreamSessionTool.handler(
      { sessionId: 's1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/Streams API 500/);
  });
});

describe('get_stream_session — upstream error (fast path)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET webapp');
    }) as unknown as typeof globalThis.fetch;

    const r = await getStreamSessionTool.handler(
      { sessionId: 's1', streamId: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNRESET/);
  });
});
