/**
 * Vitest for native tool: create_conversation
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import createConversationTool from '../../src/lib/tools/native/create-conversation';

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

describe('create_conversation — schema', () => {
  test('exposes optional inputs only', () => {
    expect(createConversationTool.description.toLowerCase()).toContain('conversation');
    expect(createConversationTool.inputSchema.required).toEqual([]);
    expect(createConversationTool.inputSchema.properties.title).toBeDefined();
    expect(createConversationTool.inputSchema.properties.graphId).toBeDefined();
    expect(createConversationTool.inputSchema.properties.metadata).toBeDefined();
  });

  test('server is "conversation"', () => {
    expect(createConversationTool.server).toBe('conversation');
  });
});

describe('create_conversation — happy path', () => {
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

  test('returns { conversationId, createdAt } on 200 OK', async () => {
    const createdAt = new Date('2026-04-27T12:00:00Z').toISOString();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/conversations');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.title).toBe('Hello');
      return new Response(
        JSON.stringify({
          conversation: { id: 'conv_abc123', createdAt, title: 'Hello' },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await createConversationTool.handler(
      { title: 'Hello' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      conversationId: 'conv_abc123',
      createdAt,
    });
  });

  test('omits all fields when no args provided', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({ conversation: { id: 'conv_x', createdAt: 'now' } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await createConversationTool.handler({}, makeMockContext());
    expect(captured).toEqual({});
  });

  test('forwards graphId and metadata when provided', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({ conversation: { id: 'conv_x', createdAt: 'now' } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await createConversationTool.handler(
      { title: 'X', graphId: 'red-assistant', metadata: { source: 'agent' } },
      makeMockContext(),
    );
    expect(captured.title).toBe('X');
    expect(captured.graphId).toBe('red-assistant');
    expect(captured.metadata).toEqual({ source: 'agent' });
  });
});

describe('create_conversation — validation errors', () => {
  test('empty title returns isError + VALIDATION', async () => {
    const r = await createConversationTool.handler(
      { title: '   ' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('create_conversation — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await createConversationTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED webapp');
    }) as unknown as typeof globalThis.fetch;

    const r = await createConversationTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });
});
