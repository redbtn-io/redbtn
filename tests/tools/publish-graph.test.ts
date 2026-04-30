/**
 * Vitest for native tool: publish_graph
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import publishGraphTool from '../../src/lib/tools/native/publish-graph';

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

describe('publish_graph — schema', () => {
  test('graphId is required', () => {
    expect(publishGraphTool.server).toBe('platform');
    expect(publishGraphTool.inputSchema.required).toEqual(['graphId']);
  });
});

describe('publish_graph — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('returns ok + version + publishedAt + promotedNodes', async () => {
    const publishedAt = new Date('2026-04-27T12:00:00Z').toISOString();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/graphs/g1/publish');
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({ success: true, graphId: 'g1', version: 3, publishedAt, promotedNodes: ['g1-context-abc', 'g1-respond-xyz'] }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await publishGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.version).toBe(3);
    expect(parsed.publishedAt).toBe(publishedAt);
    expect(parsed.promotedNodes).toHaveLength(2);
  });
});

describe('publish_graph — validation errors', () => {
  test('missing graphId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await publishGraphTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('publish_graph — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await publishGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('403 (system graph) surfaces FORBIDDEN', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'System graphs cannot be published via this endpoint' } }),
      { status: 403, statusText: 'Forbidden' },
    )) as unknown as typeof globalThis.fetch;
    const r = await publishGraphTool.handler({ graphId: 'red-assistant' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('FORBIDDEN');
  });

  test('500 surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof globalThis.fetch;
    const r = await publishGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
