/**
 * Vitest for native tool: get_conversation_metadata
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getConversationMetadataTool from '../../src/lib/tools/native/get-conversation-metadata';

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

describe('get_conversation_metadata — schema', () => {
  test('requires conversationId', () => {
    expect(getConversationMetadataTool.inputSchema.required).toEqual(['conversationId']);
  });
});

describe('get_conversation_metadata — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('projects to spec shape', async () => {
    const createdAt = '2026-04-01T00:00:00.000Z';
    const lastMessageAt = '2026-04-27T12:00:00.000Z';
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          conversation: {
            id: 'c1',
            title: 'My chat',
            createdAt,
            lastMessageAt,
            messageCount: 7,
            participants: [{ userId: 'u1', role: 'owner' }],
            messages: [{ id: 'm1' }], // should be ignored in projection
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await getConversationMetadataTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body).toEqual({
      id: 'c1',
      title: 'My chat',
      graphId: null,
      createdAt,
      lastMessageAt,
      messageCount: 7,
      participants: [{ userId: 'u1', role: 'owner' }],
    });
  });

  test('handles missing optional fields gracefully', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ conversation: { id: 'c1' } }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const r = await getConversationMetadataTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.title).toBeNull();
    expect(body.participants).toEqual([]);
  });
});

describe('get_conversation_metadata — validation errors', () => {
  test('missing conversationId returns isError', async () => {
    // @ts-expect-error
    const r = await getConversationMetadataTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('get_conversation_metadata — upstream error', () => {
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
    const r = await getConversationMetadataTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(403);
  });
});
