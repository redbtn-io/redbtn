/**
 * Integration test for the native stream pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a
 * small graph using the new tools end-to-end."
 *
 * The redbtn graph compiler depends on MongoDB / Redis / LangGraph plumbing
 * which is not always available in CI. This test exercises the layer a graph
 * node actually calls when it runs a `tool` step, in the canonical lifecycle
 * order an agent would follow when driving a stream:
 *
 *   1. NativeToolRegistry singleton has all 4 stream-pack tools registered.
 *   2. A simulated multi-step "graph" runs:
 *        list_stream_sessions  → discover what's already running for a stream
 *        start_stream_session  → spawn a fresh session
 *        get_stream_session    → confirm the session warmed up
 *        list_stream_sessions  → confirm the session is now in the listing
 *        end_stream_session    → drain the session
 *        get_stream_session    → confirm post-end status is 'draining'
 *
 * The webapp API is mocked via global fetch with an in-memory backing store
 * that mimics StreamSession collection semantics so the chain is observable
 * end-to-end (state mutations across calls are visible).
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';

// Re-import each tool by path. In production, native-registry.ts loads each
// via require('./native/foo.js'); when running TS sources under vitest those
// .js paths don't exist next to the .ts module, so the catch block silently
// swallows the failure. We work around it by importing the TS modules and
// explicitly re-registering them with the singleton.
import startStreamSessionTool from '../../src/lib/tools/native/start-stream-session';
import endStreamSessionTool from '../../src/lib/tools/native/end-stream-session';
import getStreamSessionTool from '../../src/lib/tools/native/get-stream-session';
import listStreamSessionsTool from '../../src/lib/tools/native/list-stream-sessions';

const WEBAPP = 'http://test-webapp.example';

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

interface MockSession {
  sessionId: string;
  streamId: string;
  userId: string;
  status: 'queued' | 'warming' | 'active' | 'draining' | 'ended' | 'error';
  triggeredBy: string;
  triggerData?: Record<string, any>;
  startedAt: string;
  warmUpCompletedAt?: string;
  endedAt?: string;
  endRequestedBy?: string;
  turnCount: number;
  runIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface MockStream {
  streamId: string;
  name: string;
  userId: string;
}

/**
 * In-memory mock for the webapp's /api/v1/streams API.
 *
 * Routes handled:
 *   GET    /api/v1/streams                                    → list streams
 *   GET    /api/v1/streams/:streamId/sessions                 → list sessions for stream
 *   POST   /api/v1/streams/:streamId/sessions                 → create session
 *   GET    /api/v1/streams/:streamId/sessions/:sessionId      → get session
 *   POST   /api/v1/streams/sessions/:sessionId/end            → end session
 */
function createMockStreamsApi(state: {
  streams: MockStream[];
  sessions: MockSession[];
}): typeof globalThis.fetch {
  let nextSessionCount = 0;

  function nextSessionId(): string {
    nextSessionCount += 1;
    return `sess-${nextSessionCount.toString().padStart(3, '0')}`;
  }

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : (input as URL).toString();
    const url = new URL(u);
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();

    // GET /api/v1/streams
    if (method === 'GET' && path === '/api/v1/streams') {
      return new Response(
        JSON.stringify({
          streams: state.streams.map((s) => ({
            streamId: s.streamId,
            name: s.name,
          })),
        }),
        { status: 200 },
      );
    }

    // /api/v1/streams/:streamId/sessions[/:sessionId]
    const sessionsMatch = path.match(
      /^\/api\/v1\/streams\/([^/]+)\/sessions(?:\/([^/]+))?$/,
    );
    if (sessionsMatch) {
      const streamId = decodeURIComponent(sessionsMatch[1]);
      const sessionId = sessionsMatch[2]
        ? decodeURIComponent(sessionsMatch[2])
        : null;
      const stream = state.streams.find((s) => s.streamId === streamId);
      if (!stream) {
        return new Response(
          JSON.stringify({ error: { message: 'Stream not found' } }),
          { status: 404 },
        );
      }

      if (sessionId === null && method === 'GET') {
        const status = url.searchParams.get('status');
        let scoped = state.sessions.filter((s) => s.streamId === streamId);
        if (status) scoped = scoped.filter((s) => s.status === status);
        scoped = scoped.sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        );
        return new Response(JSON.stringify({ sessions: scoped }), { status: 200 });
      }

      if (sessionId === null && method === 'POST') {
        let body: any = {};
        try {
          body = JSON.parse(String(init?.body ?? '{}'));
        } catch {
          /* ignore */
        }
        const now = new Date().toISOString();
        const sess: MockSession = {
          sessionId: nextSessionId(),
          streamId,
          userId: stream.userId,
          status: 'queued',
          triggeredBy: 'api',
          triggerData: body.triggerData,
          startedAt: now,
          turnCount: 0,
          runIds: [],
          createdAt: now,
          updatedAt: now,
        };
        state.sessions.push(sess);
        return new Response(
          JSON.stringify({ success: true, sessionId: sess.sessionId, session: sess }),
          { status: 201 },
        );
      }

      if (sessionId !== null && method === 'GET') {
        const sess = state.sessions.find(
          (s) => s.streamId === streamId && s.sessionId === sessionId,
        );
        if (!sess) {
          return new Response(
            JSON.stringify({ error: { message: 'Session not found' } }),
            { status: 404 },
          );
        }
        return new Response(JSON.stringify({ session: sess }), { status: 200 });
      }
    }

    // POST /api/v1/streams/sessions/:sessionId/end
    const endMatch = path.match(
      /^\/api\/v1\/streams\/sessions\/([^/]+)\/end$/,
    );
    if (endMatch && method === 'POST') {
      const sessionId = decodeURIComponent(endMatch[1]);
      const sess = state.sessions.find((s) => s.sessionId === sessionId);
      if (!sess) {
        return new Response(
          JSON.stringify({ error: { message: 'Session not found' } }),
          { status: 404 },
        );
      }
      if (sess.status === 'ended' || sess.status === 'error') {
        return new Response(
          JSON.stringify({
            error: {
              message: `Session is already ${sess.status} and cannot be ended.`,
              code: 'session_terminal',
            },
          }),
          { status: 409 },
        );
      }
      sess.status = 'draining';
      sess.endRequestedBy = 'client';
      sess.updatedAt = new Date().toISOString();
      return new Response(JSON.stringify({ success: true, session: sess }), {
        status: 200,
      });
    }

    return new Response(`unmocked: ${method} ${path}`, { status: 500 });
  }) as unknown as typeof globalThis.fetch;
}

describe('stream pack integration — registration + chained execution', () => {
  beforeAll(() => {
    const registry = getNativeRegistry();
    if (!registry.has('start_stream_session'))
      registry.register('start_stream_session', startStreamSessionTool);
    if (!registry.has('end_stream_session'))
      registry.register('end_stream_session', endStreamSessionTool);
    if (!registry.has('get_stream_session'))
      registry.register('get_stream_session', getStreamSessionTool);
    if (!registry.has('list_stream_sessions'))
      registry.register('list_stream_sessions', listStreamSessionsTool);
  });

  test('NativeToolRegistry has all 4 stream-pack tools registered', () => {
    const registry = getNativeRegistry();
    for (const name of [
      'start_stream_session',
      'end_stream_session',
      'get_stream_session',
      'list_stream_sessions',
    ]) {
      expect(registry.has(name)).toBe(true);
    }

    // All four share the 'stream' server label
    for (const name of [
      'start_stream_session',
      'end_stream_session',
      'get_stream_session',
      'list_stream_sessions',
    ]) {
      expect(registry.get(name)?.server).toBe('stream');
    }
  });

  describe('end-to-end: discover → start → inspect → list → end', () => {
    let originalFetch: typeof globalThis.fetch;
    let mockState: { streams: MockStream[]; sessions: MockSession[] };

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      process.env.WEBAPP_URL = WEBAPP;

      mockState = {
        streams: [
          { streamId: 'stream-voice', name: 'Voice Channel', userId: 'user-int' },
          { streamId: 'stream-chat', name: 'Chat Channel', userId: 'user-int' },
        ],
        sessions: [],
      };
      globalThis.fetch = createMockStreamsApi(mockState);
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    test('agent drives a session through its full lifecycle', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      // 1. list_stream_sessions — confirm nothing's running yet on stream-voice
      const initialList = await registry.callTool(
        'list_stream_sessions',
        { streamId: 'stream-voice' },
        ctx,
      );
      expect(initialList.isError).toBeFalsy();
      const initialBody = JSON.parse(initialList.content[0].text);
      expect(initialBody.sessions).toHaveLength(0);

      // 2. start_stream_session — spawn a fresh session with metadata
      const startResult = await registry.callTool(
        'start_stream_session',
        {
          streamId: 'stream-voice',
          metadata: { source: 'agent', purpose: 'integration-test' },
        },
        ctx,
      );
      expect(startResult.isError).toBeFalsy();
      const startBody = JSON.parse(startResult.content[0].text);
      expect(startBody.sessionId).toBeDefined();
      expect(startBody.streamId).toBe('stream-voice');
      // The mock returns 'queued' (real API behaviour); the spec advertises
      // 'warming'. Verify we forward what the API actually wrote.
      expect(startBody.status).toBe('queued');

      const sessionId: string = startBody.sessionId;

      // Confirm the metadata was forwarded as triggerData on the doc
      const created = mockState.sessions.find((s) => s.sessionId === sessionId);
      expect(created?.triggerData).toEqual({
        source: 'agent',
        purpose: 'integration-test',
      });

      // 3. get_stream_session — fast-path with streamId hint
      const getResultFast = await registry.callTool(
        'get_stream_session',
        { sessionId, streamId: 'stream-voice' },
        ctx,
      );
      expect(getResultFast.isError).toBeFalsy();
      const fastBody = JSON.parse(getResultFast.content[0].text);
      expect(fastBody.session.sessionId).toBe(sessionId);
      expect(fastBody.session.streamId).toBe('stream-voice');
      expect(fastBody.session.status).toBe('queued');

      // 3b. get_stream_session — discovery walk (no hint), still finds it
      const getResultWalk = await registry.callTool(
        'get_stream_session',
        { sessionId },
        ctx,
      );
      expect(getResultWalk.isError).toBeFalsy();
      const walkBody = JSON.parse(getResultWalk.content[0].text);
      expect(walkBody.session.sessionId).toBe(sessionId);

      // 4. list_stream_sessions — fan-out (no streamId), session shows up
      const fanOutList = await registry.callTool(
        'list_stream_sessions',
        {},
        ctx,
      );
      expect(fanOutList.isError).toBeFalsy();
      const fanOutBody = JSON.parse(fanOutList.content[0].text);
      expect(fanOutBody.sessions).toHaveLength(1);
      expect(fanOutBody.sessions[0].sessionId).toBe(sessionId);

      // 5. end_stream_session — drain the session
      const endResult = await registry.callTool(
        'end_stream_session',
        { sessionId },
        ctx,
      );
      expect(endResult.isError).toBeFalsy();
      const endBody = JSON.parse(endResult.content[0].text);
      expect(endBody.ok).toBe(true);
      expect(endBody.finalStatus).toBe('draining');

      // 6. get_stream_session — confirm the session is now draining
      const postEndGet = await registry.callTool(
        'get_stream_session',
        { sessionId, streamId: 'stream-voice' },
        ctx,
      );
      expect(postEndGet.isError).toBeFalsy();
      const postEndBody = JSON.parse(postEndGet.content[0].text);
      expect(postEndBody.session.status).toBe('draining');
      expect(postEndBody.session.endRequestedBy).toBe('client');

      // 7. end_stream_session called twice on a now-terminal session — verify
      // we surface SESSION_TERMINAL as isError (idempotency check). We have
      // to first manually transition the mock session to 'ended' since the
      // mock /end route only writes 'draining'.
      const sess = mockState.sessions.find((s) => s.sessionId === sessionId);
      if (sess) sess.status = 'ended';

      const doubleEnd = await registry.callTool(
        'end_stream_session',
        { sessionId },
        ctx,
      );
      expect(doubleEnd.isError).toBe(true);
      const doubleBody = JSON.parse(doubleEnd.content[0].text);
      expect(doubleBody.code).toBe('SESSION_TERMINAL');
    });

    test('agent flow handles session_not_found at get step', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      // No sessions exist — discovery walk must surface session_not_found
      const r = await registry.callTool(
        'get_stream_session',
        { sessionId: 'phantom' },
        ctx,
      );
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text).error).toBe('session_not_found');
    });

    test('list_stream_sessions status filter is applied in fan-out mode', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      // Pre-populate a few sessions across both streams with different statuses
      const now = new Date();
      mockState.sessions.push(
        {
          sessionId: 'sa-active',
          streamId: 'stream-voice',
          userId: 'user-int',
          status: 'active',
          triggeredBy: 'api',
          startedAt: new Date(now.getTime() - 1000).toISOString(),
          turnCount: 1,
          runIds: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        {
          sessionId: 'sa-ended',
          streamId: 'stream-voice',
          userId: 'user-int',
          status: 'ended',
          triggeredBy: 'api',
          startedAt: new Date(now.getTime() - 2000).toISOString(),
          turnCount: 5,
          runIds: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        {
          sessionId: 'sb-active',
          streamId: 'stream-chat',
          userId: 'user-int',
          status: 'active',
          triggeredBy: 'api',
          startedAt: now.toISOString(),
          turnCount: 0,
          runIds: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      );

      const r = await registry.callTool(
        'list_stream_sessions',
        { status: 'active' },
        ctx,
      );
      expect(r.isError).toBeFalsy();
      const body = JSON.parse(r.content[0].text);
      expect(body.sessions).toHaveLength(2);
      // Sorted by startedAt desc — sb-active is the most recent
      expect(body.sessions[0].sessionId).toBe('sb-active');
      expect(body.sessions[1].sessionId).toBe('sa-active');
    });
  });
});
