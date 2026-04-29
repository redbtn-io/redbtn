/**
 * Vitest for native tool: list_conversations
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import listConversationsTool from '../../src/lib/tools/native/list-conversations';

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

describe('list_conversations — schema', () => {
  test('exposes paging + filter inputs', () => {
    expect(listConversationsTool.description.toLowerCase()).toContain('conversation');
    expect(listConversationsTool.inputSchema.required).toEqual([]);
    expect(listConversationsTool.inputSchema.properties.limit).toBeDefined();
    expect(listConversationsTool.inputSchema.properties.offset).toBeDefined();
    expect(listConversationsTool.inputSchema.properties.search).toBeDefined();
    expect(listConversationsTool.inputSchema.properties.archived).toBeDefined();
  });
});

describe('list_conversations — happy path', () => {
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

  test('returns { conversations, total } with default paging', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('limit=20');
      expect(u).toContain('offset=0');
      expect(u).not.toContain('includeArchived');
      return new Response(
        JSON.stringify({
          conversations: [
            { id: 'c1', title: 'one' },
            { id: 'c2', title: 'two' },
          ],
          total: 2,
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await listConversationsTool.handler({}, makeMockContext());
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.conversations).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  test('forwards archived as includeArchived=true', async () => {
    let url = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      url = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ conversations: [], total: 0 }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listConversationsTool.handler({ archived: true }, makeMockContext());
    expect(url).toContain('includeArchived=true');
  });

  test('client-side search filter narrows the result', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          conversations: [
            { id: 'c1', title: 'cooking ideas' },
            { id: 'c2', title: 'travel notes' },
            { id: 'c3', title: 'recipe brainstorm' },
          ],
          total: 3,
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const result = await listConversationsTool.handler(
      { search: 'cook' },
      makeMockContext(),
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].id).toBe('c1');
    expect(body.total).toBe(1);
  });

  test('clamps limit into 1..200 and offset to >=0', async () => {
    let url = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      url = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ conversations: [], total: 0 }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listConversationsTool.handler({ limit: 9999, offset: -10 }, makeMockContext());
    expect(url).toContain('limit=200');
    expect(url).toContain('offset=0');

    await listConversationsTool.handler({ limit: 0 }, makeMockContext());
    expect(url).toContain('limit=1');
  });
});

describe('list_conversations — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('401 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await listConversationsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(401);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('EHOSTUNREACH api');
    }) as unknown as typeof globalThis.fetch;
    const r = await listConversationsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/EHOSTUNREACH/);
  });
});
