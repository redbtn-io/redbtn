/**
 * Vitest for native tool: fork_graph
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import forkGraphTool from '../../src/lib/tools/native/fork-graph';

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

describe('fork_graph — schema', () => {
  test('graphId required, newGraphId/name optional', () => {
    expect(forkGraphTool.server).toBe('platform');
    expect(forkGraphTool.inputSchema.required).toEqual(['graphId']);
    expect(forkGraphTool.inputSchema.properties.newGraphId).toBeDefined();
    expect(forkGraphTool.inputSchema.properties.name).toBeDefined();
  });
});

describe('fork_graph — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('returns { graphId, forkedFrom, name } on 201', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/graphs/red-assistant/fork');
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({ success: true, graphId: 'g_fork_xyz', parentGraphId: 'red-assistant', name: 'Red Assistant (Fork)', createdAt: 'now' }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await forkGraphTool.handler({ graphId: 'red-assistant' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.graphId).toBe('g_fork_xyz');
    expect(parsed.forkedFrom).toBe('red-assistant');
  });

  test('forwards newGraphId and name when provided', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ graphId: 'my-fork', parentGraphId: 'red-chat' }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    await forkGraphTool.handler({ graphId: 'red-chat', newGraphId: 'my-fork', name: 'My Fork' }, makeMockContext());
    expect(captured).toEqual({ newGraphId: 'my-fork', name: 'My Fork' });
  });
});

describe('fork_graph — validation errors', () => {
  test('missing graphId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await forkGraphTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('fork_graph — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await forkGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('409 surfaces CONFLICT', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Already exists' }), { status: 409, statusText: 'Conflict' })) as unknown as typeof globalThis.fetch;
    const r = await forkGraphTool.handler({ graphId: 'g1', newGraphId: 'taken' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('CONFLICT');
  });

  test('500 surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof globalThis.fetch;
    const r = await forkGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
