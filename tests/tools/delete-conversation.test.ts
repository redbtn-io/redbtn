/**
 * Vitest for native tool: delete_conversation
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 *
 * Covers both archive (default, PATCH) and hard-delete (DELETE) paths.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import deleteConversationTool from '../../src/lib/tools/native/delete-conversation';

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

describe('delete_conversation — schema', () => {
  test('requires conversationId, archive optional (default true)', () => {
    expect(deleteConversationTool.inputSchema.required).toEqual(['conversationId']);
    expect(deleteConversationTool.inputSchema.properties.archive).toBeDefined();
  });
});

describe('delete_conversation — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('default archives via PATCH { isArchived: true }', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.isArchived).toBe(true);
      return new Response(
        JSON.stringify({ conversation: { id: 'c1', isArchived: true } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteConversationTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, archived: true });
  });

  test('archive=false hard-deletes via DELETE', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('DELETE');
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteConversationTool.handler(
      { conversationId: 'c1', archive: false },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, archived: false });
  });

  test('explicit archive: true uses PATCH', async () => {
    let method = '';
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      method = init?.method || '';
      return new Response(JSON.stringify({ conversation: {} }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await deleteConversationTool.handler(
      { conversationId: 'c1', archive: true },
      makeMockContext(),
    );
    expect(method).toBe('PATCH');
  });
});

describe('delete_conversation — validation errors', () => {
  test('missing conversationId returns isError', async () => {
    // @ts-expect-error
    const r = await deleteConversationTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('delete_conversation — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('403 on hard-delete (non-owner) surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
    ) as unknown as typeof globalThis.fetch;
    const r = await deleteConversationTool.handler(
      { conversationId: 'c1', archive: false },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(403);
  });
});
