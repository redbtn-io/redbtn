/**
 * Vitest for native tool: list_threads
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import listThreadsTool from '../../src/lib/tools/native/list-threads';

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

describe('list_threads — schema', () => {
  test('requires conversationId', () => {
    expect(listThreadsTool.inputSchema.required).toEqual(['conversationId']);
  });
});

describe('list_threads — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('projects threads to spec shape', async () => {
    const lastReplyAt = new Date().toISOString();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/conversations/c1/threads');
      return new Response(
        JSON.stringify({
          threads: [
            {
              id: 't1',
              parentMessageId: 'm1',
              replyCount: 3,
              lastMessageAt: lastReplyAt,
              title: 'Side discussion',
            },
            {
              id: 't2',
              parentMessageId: 'm5',
              replyCount: 0,
              lastMessageAt: null,
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await listThreadsTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.threads).toHaveLength(2);
    expect(body.threads[0]).toEqual({
      threadId: 't1',
      parentMessageId: 'm1',
      replyCount: 3,
      lastReplyAt,
      title: 'Side discussion',
    });
    expect(body.threads[1].replyCount).toBe(0);
    expect(body.threads[1].lastReplyAt).toBeNull();
  });

  test('empty threads array', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ threads: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const r = await listThreadsTool.handler({ conversationId: 'c1' }, makeMockContext());
    const body = JSON.parse(r.content[0].text);
    expect(body.threads).toEqual([]);
  });
});

describe('list_threads — validation errors', () => {
  test('missing conversationId returns isError', async () => {
    // @ts-expect-error
    const r = await listThreadsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('list_threads — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;
    const r = await listThreadsTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
