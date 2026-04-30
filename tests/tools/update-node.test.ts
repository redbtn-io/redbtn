/**
 * Vitest for native tool: update_node
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import updateNodeTool from '../../src/lib/tools/native/update-node';

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

describe('update_node — schema', () => {
  test('nodeId + patch required', () => {
    expect(updateNodeTool.server).toBe('platform');
    expect(updateNodeTool.inputSchema.required).toEqual(['nodeId', 'patch']);
  });
});

describe('update_node — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('returns ok + version + updatedAt on direct edit', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/nodes/n1');
      expect(init?.method).toBe('PATCH');
      return new Response(
        JSON.stringify({ nodeId: 'n1', cloned: false, name: 'Renamed', version: 4, updatedAt: 'now' }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await updateNodeTool.handler({ nodeId: 'n1', patch: { name: 'Renamed' } }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.forked).toBe(false);
    expect(parsed.version).toBe(4);
  });

  test('forked: true on auto-fork response', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ nodeId: 'context-abc123', forked: true, originalNodeId: 'context', name: 'Custom', version: 1, createdAt: 'now' }),
      { status: 201 },
    )) as unknown as typeof globalThis.fetch;

    const r = await updateNodeTool.handler({ nodeId: 'context', patch: { steps: [] } }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.forked).toBe(true);
    expect(parsed.originalNodeId).toBe('context');
    expect(parsed.nodeId).toBe('context-abc123');
  });
});

describe('update_node — validation errors', () => {
  test('missing nodeId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await updateNodeTool.handler({ patch: {} }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing patch returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await updateNodeTool.handler({ nodeId: 'n1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('update_node — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await updateNodeTool.handler({ nodeId: 'n1', patch: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('403 surfaces FORBIDDEN', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Fork required' }), { status: 403, statusText: 'Forbidden' })) as unknown as typeof globalThis.fetch;
    const r = await updateNodeTool.handler({ nodeId: 'context', patch: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('FORBIDDEN');
  });

  test('500 surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof globalThis.fetch;
    const r = await updateNodeTool.handler({ nodeId: 'n1', patch: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
