/**
 * Vitest for native tool: create_thread
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 *
 * Covers both two-call (with firstMessage) and one-call (without) paths.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import createThreadTool from '../../src/lib/tools/native/create-thread';

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

describe('create_thread — schema', () => {
  test('requires conversationId + parentMessageId, firstMessage optional', () => {
    expect(createThreadTool.inputSchema.required).toEqual([
      'conversationId',
      'parentMessageId',
    ]);
    expect(createThreadTool.inputSchema.properties.firstMessage).toBeDefined();
  });
});

describe('create_thread — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('creates thread without firstMessage (single call)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('/conversations/c1/threads');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.parentMessageId).toBe('m1');
      return new Response(
        JSON.stringify({ threadConversationId: 'thread_xyz', created: true }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await createThreadTool.handler(
      { conversationId: 'c1', parentMessageId: 'm1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ threadId: 'thread_xyz' });
    expect(calls).toBe(1);
  });

  test('with firstMessage: posts a follow-up message', async () => {
    let calls = 0;
    let secondCallUrl = '';
    let secondCallBody: any = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (calls === 1) {
        return new Response(
          JSON.stringify({ threadConversationId: 'thread_abc', created: true }),
          { status: 200 },
        );
      }
      // Second call should hit the new thread's messages endpoint
      secondCallUrl = u;
      secondCallBody = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          message: { id: 'm_new', content: 'kickoff', timestamp: new Date().toISOString() },
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await createThreadTool.handler(
      { conversationId: 'c1', parentMessageId: 'm1', firstMessage: 'kickoff' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ threadId: 'thread_abc' });
    expect(calls).toBe(2);
    expect(secondCallUrl).toContain('/conversations/thread_abc/messages');
    expect(secondCallBody.content).toBe('kickoff');
  });

  test('idempotent: returns existing threadId on duplicate create', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ threadConversationId: 'thread_existing', created: false }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await createThreadTool.handler(
      { conversationId: 'c1', parentMessageId: 'm1' },
      makeMockContext(),
    );
    expect(JSON.parse(r.content[0].text)).toEqual({ threadId: 'thread_existing' });
  });
});

describe('create_thread — validation errors', () => {
  test('missing conversationId returns isError', async () => {
    // @ts-expect-error
    const r = await createThreadTool.handler({ parentMessageId: 'm1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing parentMessageId returns isError', async () => {
    // @ts-expect-error
    const r = await createThreadTool.handler({ conversationId: 'c1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('create_thread — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('thread create 500 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;
    const r = await createThreadTool.handler(
      { conversationId: 'c1', parentMessageId: 'm1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('thread created but message post fails — partial-success error returns threadId', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ threadConversationId: 'thread_ok', created: true }),
          { status: 200 },
        );
      }
      return new Response('Bad request', { status: 400, statusText: 'Bad Request' });
    }) as unknown as typeof globalThis.fetch;

    const r = await createThreadTool.handler(
      { conversationId: 'c1', parentMessageId: 'm1', firstMessage: 'msg' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.threadId).toBe('thread_ok');
    expect(body.error).toMatch(/firstMessage post failed/);
    expect(body.status).toBe(400);
  });
});
