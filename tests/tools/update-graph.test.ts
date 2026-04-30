/**
 * Vitest for native tool: update_graph
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import updateGraphTool from '../../src/lib/tools/native/update-graph';

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

describe('update_graph — schema', () => {
  test('graphId + patch are required', () => {
    expect(updateGraphTool.server).toBe('platform');
    expect(updateGraphTool.inputSchema.required).toEqual(['graphId', 'patch']);
  });
});

describe('update_graph — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('returns ok + updatedAt on direct edit', async () => {
    const updatedAt = new Date('2026-04-27T12:00:00Z').toISOString();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/graphs/g1');
      expect(init?.method).toBe('PATCH');
      return new Response(
        JSON.stringify({ graphId: 'g1', cloned: false, name: 'Renamed', updatedAt }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await updateGraphTool.handler({ graphId: 'g1', patch: { name: 'Renamed' } }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.cloned).toBe(false);
    expect(parsed.updatedAt).toBe(updatedAt);
  });

  test('cloned: true on auto-fork response', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ graphId: 'g1-fork', cloned: true, parentGraphId: 'g1-system', name: 'Custom', createdAt: 'now' }),
      { status: 201 },
    )) as unknown as typeof globalThis.fetch;

    const r = await updateGraphTool.handler({ graphId: 'g1-system', patch: { name: 'Custom', nodes: [], edges: [] } }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.cloned).toBe(true);
    expect(parsed.graphId).toBe('g1-fork');
    expect(parsed.parentGraphId).toBe('g1-system');
  });
});

describe('update_graph — validation errors', () => {
  test('missing graphId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await updateGraphTool.handler({ patch: {} }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing patch returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await updateGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('update_graph — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await updateGraphTool.handler({ graphId: 'g1', patch: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('404 surfaces NOT_FOUND', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Not Found', { status: 404, statusText: 'Not Found' })) as unknown as typeof globalThis.fetch;
    const r = await updateGraphTool.handler({ graphId: 'phantom', patch: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('NOT_FOUND');
  });

  test('500 surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof globalThis.fetch;
    const r = await updateGraphTool.handler({ graphId: 'g1', patch: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.status).toBe(500);
    expect(parsed.code).toBe('UPSTREAM_ERROR');
  });
});
