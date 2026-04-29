/**
 * Vitest for native tool: get_messages
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getMessagesTool from '../../src/lib/tools/native/get-messages';

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

describe('get_messages — schema', () => {
  test('requires conversationId, supports limit + before', () => {
    expect(getMessagesTool.inputSchema.required).toEqual(['conversationId']);
    expect(getMessagesTool.inputSchema.properties.limit).toBeDefined();
    expect(getMessagesTool.inputSchema.properties.before).toBeDefined();
  });
});

describe('get_messages — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('default limit=50, no before', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('/conversations/conv1/messages');
      expect(u).toContain('limit=50');
      expect(u).not.toContain('before=');
      return new Response(
        JSON.stringify({
          messages: [
            { id: 'm1', content: 'hi' },
            { id: 'm2', content: 'hey' },
          ],
          hasMore: false,
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await getMessagesTool.handler({ conversationId: 'conv1' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.messages).toHaveLength(2);
    expect(body.hasMore).toBe(false);
  });

  test('forwards before cursor', async () => {
    let url = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      url = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ messages: [], hasMore: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await getMessagesTool.handler(
      { conversationId: 'c1', before: 1700000000000, limit: 25 },
      makeMockContext(),
    );
    expect(url).toContain('before=1700000000000');
    expect(url).toContain('limit=25');
  });
});

describe('get_messages — validation errors', () => {
  test('missing conversationId returns isError + VALIDATION', async () => {
    // @ts-expect-error
    const r = await getMessagesTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('non-numeric before is rejected', async () => {
    const r = await getMessagesTool.handler(
      { conversationId: 'c1', before: 'not-a-number' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('get_messages — upstream error', () => {
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

    const r = await getMessagesTool.handler({ conversationId: 'c1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
