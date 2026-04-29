/**
 * Vitest for native tool: get_conversation
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getConversationTool from '../../src/lib/tools/native/get-conversation';

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

describe('get_conversation — schema', () => {
  test('requires conversationId, includeMessages optional', () => {
    expect(getConversationTool.inputSchema.required).toEqual(['conversationId']);
    expect(getConversationTool.inputSchema.properties.conversationId).toBeDefined();
    expect(getConversationTool.inputSchema.properties.includeMessages).toBeDefined();
  });
});

describe('get_conversation — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('strips messages by default', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/conversations/conv1');
      return new Response(
        JSON.stringify({
          conversation: {
            id: 'conv1',
            title: 'Test',
            messages: [{ id: 'm1', content: 'hi' }],
            participants: [],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await getConversationTool.handler(
      { conversationId: 'conv1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.conversation.id).toBe('conv1');
    expect(body.conversation.messages).toBeUndefined();
  });

  test('includes messages when includeMessages: true', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          conversation: {
            id: 'conv1',
            title: 'Test',
            messages: [{ id: 'm1', content: 'hi' }],
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await getConversationTool.handler(
      { conversationId: 'conv1', includeMessages: true },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.conversation.messages).toHaveLength(1);
  });
});

describe('get_conversation — validation errors', () => {
  test('missing conversationId returns isError + VALIDATION', async () => {
    // @ts-expect-error
    const r = await getConversationTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('get_conversation — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('404 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Not found', { status: 404, statusText: 'Not Found' }),
    ) as unknown as typeof globalThis.fetch;
    const r = await getConversationTool.handler(
      { conversationId: 'missing' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(404);
  });
});
