/**
 * Vitest for native tool: fork_node
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import forkNodeTool from '../../src/lib/tools/native/fork-node';

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

describe('fork_node — schema', () => {
  test('nodeId required, newNodeId/name optional', () => {
    expect(forkNodeTool.server).toBe('platform');
    expect(forkNodeTool.inputSchema.required).toEqual(['nodeId']);
  });
});

describe('fork_node — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('returns nodeId + forkedFrom on 201', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/nodes/context/fork');
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({ success: true, nodeId: 'context-fork', parentNodeId: 'context', name: 'My Context', createdAt: 'now' }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await forkNodeTool.handler({ nodeId: 'context' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.nodeId).toBe('context-fork');
    expect(parsed.forkedFrom).toBe('context');
  });
});

describe('fork_node — validation errors', () => {
  test('missing nodeId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await forkNodeTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('fork_node — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await forkNodeTool.handler({ nodeId: 'n1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('500 surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof globalThis.fetch;
    const r = await forkNodeTool.handler({ nodeId: 'n1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
