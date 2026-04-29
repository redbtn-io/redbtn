/**
 * Vitest for native tool: get_conversation_summary
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getConversationSummaryTool from '../../src/lib/tools/native/get-conversation-summary';

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

describe('get_conversation_summary — schema', () => {
  test('requires conversationId, regenerate optional', () => {
    expect(getConversationSummaryTool.inputSchema.required).toEqual(['conversationId']);
    expect(getConversationSummaryTool.inputSchema.properties.regenerate).toBeDefined();
  });
});

describe('get_conversation_summary — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns spec shape from cached response', async () => {
    const generatedAt = new Date().toISOString();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('/conversations/c1/summary');
      expect(u).not.toContain('regenerate=');
      return new Response(
        JSON.stringify({
          summary: 'Discussion about renaming variables.',
          executiveSummary: 'Discussion about renaming variables.',
          trailingSummary: 'Older messages compressed.',
          generatedAt,
          fromCache: true,
          regenerated: false,
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await getConversationSummaryTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.summary).toContain('renaming');
    expect(body.fromCache).toBe(true);
    expect(body.regenerated).toBe(false);
    expect(body.generatedAt).toBe(generatedAt);
  });

  test('forwards regenerate=true', async () => {
    let url = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      url = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({ summary: null, fromCache: true, regenerated: false }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await getConversationSummaryTool.handler(
      { conversationId: 'c1', regenerate: true },
      makeMockContext(),
    );
    expect(url).toContain('regenerate=true');
  });

  test('null summary is preserved (no synth)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ summary: null, fromCache: true, regenerated: false }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;
    const r = await getConversationSummaryTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.summary).toBeNull();
  });
});

describe('get_conversation_summary — validation errors', () => {
  test('missing conversationId returns isError', async () => {
    // @ts-expect-error
    const r = await getConversationSummaryTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('get_conversation_summary — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('502 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('upstream', { status: 502, statusText: 'Bad Gateway' }),
    ) as unknown as typeof globalThis.fetch;
    const r = await getConversationSummaryTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(502);
  });
});
