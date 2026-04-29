/**
 * Vitest for native tool: set_conversation_title
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import setConversationTitleTool from '../../src/lib/tools/native/set-conversation-title';

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

describe('set_conversation_title — schema', () => {
  test('requires conversationId + title', () => {
    expect(setConversationTitleTool.inputSchema.required).toEqual([
      'conversationId',
      'title',
    ]);
  });
});

describe('set_conversation_title — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('PATCHes /conversations/:id with title', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/conversations/c1');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.title).toBe('New Title');
      return new Response(JSON.stringify({ conversation: { id: 'c1', title: 'New Title' } }), {
        status: 200,
      });
    }) as unknown as typeof globalThis.fetch;

    const r = await setConversationTitleTool.handler(
      { conversationId: 'c1', title: 'New Title' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true });
  });
});

describe('set_conversation_title — validation errors', () => {
  test('empty title returns isError + VALIDATION', async () => {
    const r = await setConversationTitleTool.handler(
      { conversationId: 'c1', title: '   ' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing conversationId returns isError', async () => {
    // @ts-expect-error
    const r = await setConversationTitleTool.handler({ title: 'X' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('set_conversation_title — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('403 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
    ) as unknown as typeof globalThis.fetch;
    const r = await setConversationTitleTool.handler(
      { conversationId: 'c1', title: 'New' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(403);
  });
});
