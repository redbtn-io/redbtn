/**
 * Vitest for native tool: list_stream_sessions
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * Two execution paths:
 *  - fast path: caller passed a streamId → single GET against
 *    /api/v1/streams/:streamId/sessions.
 *  - fan-out: no streamId → GET /api/v1/streams to discover, then GET each
 *    stream's sessions list, merge, re-sort by startedAt desc, cap at limit.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import listStreamSessionsTool from '../../src/lib/tools/native/list-stream-sessions';

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

describe('list_stream_sessions — schema', () => {
  test('all inputs optional', () => {
    expect(listStreamSessionsTool.description.toLowerCase()).toContain('session');
    expect(listStreamSessionsTool.inputSchema.required).toEqual([]);
    expect(listStreamSessionsTool.inputSchema.properties.streamId).toBeDefined();
    expect(listStreamSessionsTool.inputSchema.properties.status).toBeDefined();
    expect(listStreamSessionsTool.inputSchema.properties.limit).toBeDefined();
  });

  test('status enum covers every SessionStatus', () => {
    const statusEnum = listStreamSessionsTool.inputSchema.properties.status.enum;
    expect(statusEnum).toEqual(
      expect.arrayContaining([
        'queued',
        'warming',
        'active',
        'draining',
        'ended',
        'error',
      ]),
    );
  });

  test('server is "stream"', () => {
    expect(listStreamSessionsTool.server).toBe('stream');
  });
});

describe('list_stream_sessions — validation', () => {
  test('invalid status returns isError + VALIDATION', async () => {
    const r = await listStreamSessionsTool.handler(
      // @ts-expect-error — deliberately invalid status
      { status: 'banana' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('list_stream_sessions — fast path (streamId)', () => {
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

  test('returns { sessions } for a single stream', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('/api/v1/streams/stream-x/sessions');
      expect(u).toContain('limit=50');
      return new Response(
        JSON.stringify({
          sessions: [
            {
              sessionId: 's1',
              streamId: 'stream-x',
              status: 'active',
              startedAt: '2026-04-27T12:00:00Z',
            },
            {
              sessionId: 's2',
              streamId: 'stream-x',
              status: 'ended',
              startedAt: '2026-04-26T12:00:00Z',
            },
          ],
          pagination: { total: 2, limit: 50, offset: 0, hasMore: false },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await listStreamSessionsTool.handler(
      { streamId: 'stream-x' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0].sessionId).toBe('s1');
  });

  test('forwards status filter to the API as a query param', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listStreamSessionsTool.handler(
      { streamId: 'stream-x', status: 'active' },
      makeMockContext(),
    );
    expect(capturedUrl).toContain('status=active');
  });

  test('caps limit at 100 and floors at 1', async () => {
    let capturedHigh = '';
    let capturedLow = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (capturedHigh === '') capturedHigh = u;
      else capturedLow = u;
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listStreamSessionsTool.handler(
      { streamId: 's', limit: 9999 },
      makeMockContext(),
    );
    await listStreamSessionsTool.handler(
      { streamId: 's', limit: 0 },
      makeMockContext(),
    );
    expect(capturedHigh).toContain('limit=100');
    expect(capturedLow).toContain('limit=1');
  });

  test('encodes streamId in URL', async () => {
    let captured = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      captured = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listStreamSessionsTool.handler(
      { streamId: 'has spaces & ?' },
      makeMockContext(),
    );
    expect(captured).toContain(encodeURIComponent('has spaces & ?'));
  });

  test('forwards bearer + user-id headers', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listStreamSessionsTool.handler(
      { streamId: 'x' },
      makeMockContext({ state: { authToken: 'tok-q', userId: 'user-r' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-q');
    expect(capturedHeaders['X-User-Id']).toBe('user-r');
  });
});

describe('list_stream_sessions — fan-out path (no streamId)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('lists streams then fans out, merges + sorts by startedAt desc', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      calls.push(u);

      if (u.endsWith('/api/v1/streams?limit=100')) {
        return new Response(
          JSON.stringify({
            streams: [{ streamId: 'stream-a' }, { streamId: 'stream-b' }],
          }),
          { status: 200 },
        );
      }
      if (u.includes('/streams/stream-a/sessions')) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                sessionId: 'a-old',
                streamId: 'stream-a',
                status: 'ended',
                startedAt: '2026-04-25T10:00:00Z',
              },
              {
                sessionId: 'a-newer',
                streamId: 'stream-a',
                status: 'active',
                startedAt: '2026-04-27T15:00:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (u.includes('/streams/stream-b/sessions')) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                sessionId: 'b-newest',
                streamId: 'stream-b',
                status: 'active',
                startedAt: '2026-04-27T20:00:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const result = await listStreamSessionsTool.handler({}, makeMockContext());
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.sessions).toHaveLength(3);
    // Sorted by startedAt desc → b-newest, a-newer, a-old
    expect(body.sessions.map((s: any) => s.sessionId)).toEqual([
      'b-newest',
      'a-newer',
      'a-old',
    ]);
  });

  test('caps merged result at limit', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.endsWith('/api/v1/streams?limit=100')) {
        return new Response(
          JSON.stringify({
            streams: [{ streamId: 's1' }, { streamId: 's2' }],
          }),
          { status: 200 },
        );
      }
      // Each stream returns 5 sessions
      return new Response(
        JSON.stringify({
          sessions: Array.from({ length: 5 }, (_, i) => ({
            sessionId: `${u.includes('s1') ? 's1' : 's2'}-${i}`,
            streamId: u.includes('s1') ? 's1' : 's2',
            status: 'ended',
            startedAt: new Date(2026, 3, 27, i).toISOString(),
          })),
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await listStreamSessionsTool.handler({ limit: 3 }, makeMockContext());
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).sessions).toHaveLength(3);
  });

  test('per-stream errors do not abort the fan-out', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.endsWith('/api/v1/streams?limit=100')) {
        return new Response(
          JSON.stringify({ streams: [{ streamId: 'flaky' }, { streamId: 'good' }] }),
          { status: 200 },
        );
      }
      if (u.includes('flaky')) {
        return new Response('boom', { status: 503 });
      }
      return new Response(
        JSON.stringify({
          sessions: [
            {
              sessionId: 'g1',
              streamId: 'good',
              status: 'active',
              startedAt: '2026-04-27T00:00:00Z',
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await listStreamSessionsTool.handler({}, makeMockContext());
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].streamId).toBe('good');
  });

  test('streams-list error surfaces as upstream error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await listStreamSessionsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(500);
  });

  test('forwards status filter to every per-stream call', async () => {
    const seenStatusFilters: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.endsWith('/api/v1/streams?limit=100')) {
        return new Response(
          JSON.stringify({ streams: [{ streamId: 'a' }, { streamId: 'b' }] }),
          { status: 200 },
        );
      }
      if (u.includes('/sessions?')) {
        const params = new URL(u).searchParams;
        const status = params.get('status');
        if (status) seenStatusFilters.push(status);
      }
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listStreamSessionsTool.handler({ status: 'active' }, makeMockContext());
    expect(seenStatusFilters).toEqual(['active', 'active']);
  });
});

describe('list_stream_sessions — upstream error (fast path)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 surfaces as upstream error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await listStreamSessionsTool.handler(
      { streamId: 's1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/Streams API 500/);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENETUNREACH webapp');
    }) as unknown as typeof globalThis.fetch;

    const r = await listStreamSessionsTool.handler(
      { streamId: 's1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ENETUNREACH/);
  });
});
