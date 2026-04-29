/**
 * Vitest for native tool: start_stream_session
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import startStreamSessionTool from '../../src/lib/tools/native/start-stream-session';

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

describe('start_stream_session — schema', () => {
  test('requires streamId; metadata optional', () => {
    expect(startStreamSessionTool.description.toLowerCase()).toContain('stream');
    expect(startStreamSessionTool.inputSchema.required).toEqual(['streamId']);
    expect(startStreamSessionTool.inputSchema.properties.streamId).toBeDefined();
    expect(startStreamSessionTool.inputSchema.properties.metadata).toBeDefined();
  });

  test('server is "stream"', () => {
    expect(startStreamSessionTool.server).toBe('stream');
  });
});

describe('start_stream_session — validation', () => {
  test('missing streamId returns isError + VALIDATION', async () => {
    const r = await startStreamSessionTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/streamId/);
  });

  test('whitespace-only streamId returns isError', async () => {
    const r = await startStreamSessionTool.handler(
      { streamId: '   ' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('non-object metadata returns isError', async () => {
    const r = await startStreamSessionTool.handler(
      // @ts-expect-error — deliberately wrong type
      { streamId: 's1', metadata: 'not-an-object' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('array metadata returns isError', async () => {
    const r = await startStreamSessionTool.handler(
      // @ts-expect-error — arrays are objects in JS but not the kind we want
      { streamId: 's1', metadata: ['nope'] },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('start_stream_session — happy path', () => {
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

  test('returns { sessionId, streamId, status } on 201 created', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/streams/stream-x/sessions');
      expect(init?.method).toBe('POST');
      // Empty body when no metadata is provided
      expect(JSON.parse(String(init?.body || '{}'))).toEqual({});
      return new Response(
        JSON.stringify({
          success: true,
          sessionId: 'sess-abc',
          session: {
            sessionId: 'sess-abc',
            streamId: 'stream-x',
            status: 'queued',
            triggeredBy: 'api',
          },
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await startStreamSessionTool.handler(
      { streamId: 'stream-x' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.sessionId).toBe('sess-abc');
    expect(body.streamId).toBe('stream-x');
    // Forward what the API actually wrote — typically `'queued'` immediately
    // after create, even though the spec advertises `'warming'`.
    expect(body.status).toBe('queued');
  });

  test('forwards metadata as triggerData', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          sessionId: 'sess-meta',
          session: {
            sessionId: 'sess-meta',
            streamId: 'stream-x',
            status: 'warming',
          },
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    await startStreamSessionTool.handler(
      { streamId: 'stream-x', metadata: { source: 'agent', issueId: 'OPS-42' } },
      makeMockContext(),
    );
    expect(captured).toEqual({
      triggerData: { source: 'agent', issueId: 'OPS-42' },
    });
  });

  test('encodes streamId in the URL path', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({
          sessionId: 'sess-x',
          session: { sessionId: 'sess-x', streamId: 'has spaces & ?', status: 'queued' },
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    await startStreamSessionTool.handler(
      { streamId: 'has spaces & ?' },
      makeMockContext(),
    );
    expect(capturedUrl).toContain(encodeURIComponent('has spaces & ?'));
  });

  test('forwards bearer token + user-id headers from state', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          sessionId: 's',
          session: { sessionId: 's', streamId: 'x', status: 'warming' },
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    await startStreamSessionTool.handler(
      { streamId: 'x' },
      makeMockContext({ state: { authToken: 'tok-x', userId: 'user-2' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-x');
    expect(capturedHeaders['X-User-Id']).toBe('user-2');
  });

  test('falls back to "warming" when API omits status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          sessionId: 'sess-no-status',
          session: { sessionId: 'sess-no-status', streamId: 'stream-x' },
        }),
        { status: 201 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const result = await startStreamSessionTool.handler(
      { streamId: 'stream-x' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).status).toBe('warming');
  });

  test('reads sessionId from inner session doc when wrapper omits it', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          // Note: no top-level sessionId
          session: { sessionId: 'inner-sess', streamId: 'stream-x', status: 'queued' },
        }),
        { status: 201 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const result = await startStreamSessionTool.handler(
      { streamId: 'stream-x' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).sessionId).toBe('inner-sess');
  });
});

describe('start_stream_session — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('403 forbidden surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { message: 'Owner access required' } }),
        { status: 403, statusText: 'Forbidden' },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await startStreamSessionTool.handler(
      { streamId: 'someone-elses-stream' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(403);
    expect(body.streamId).toBe('someone-elses-stream');
  });

  test('500 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await startStreamSessionTool.handler(
      { streamId: 's1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED webapp');
    }) as unknown as typeof globalThis.fetch;

    const r = await startStreamSessionTool.handler(
      { streamId: 's1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });
});
