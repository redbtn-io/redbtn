/**
 * Vitest for native tool: create_node
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import createNodeTool from '../../src/lib/tools/native/create-node';

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

describe('create_node — schema', () => {
  test('config required, server is platform', () => {
    expect(createNodeTool.server).toBe('platform');
    expect(createNodeTool.inputSchema.required).toEqual(['config']);
  });
});

describe('create_node — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('returns nodeId + name + stepsCount + createdAt on 201', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/nodes');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.name).toBe('Greeter');
      expect(Array.isArray(body.steps)).toBe(true);
      return new Response(
        JSON.stringify({ nodeId: 'n_abc', name: 'Greeter', stepsCount: 1, createdAt: 'now' }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await createNodeTool.handler(
      { config: { name: 'Greeter', steps: [{ type: 'neuron', config: { systemPrompt: 'Say hi' } }] } },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ nodeId: 'n_abc', name: 'Greeter', stepsCount: 1, createdAt: 'now' });
  });

  test('forwards nodeId at top level when provided', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ nodeId: 'my-id', name: 'X' }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    await createNodeTool.handler({ nodeId: 'my-id', config: { name: 'X', steps: [] } }, makeMockContext());
    expect(captured.nodeId).toBe('my-id');
  });
});

describe('create_node — validation errors', () => {
  test('missing config returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await createNodeTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('create_node — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await createNodeTool.handler({ config: { name: 'X', steps: [] } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('409 surfaces CONFLICT', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'duplicate' }), { status: 409, statusText: 'Conflict' })) as unknown as typeof globalThis.fetch;
    const r = await createNodeTool.handler({ nodeId: 'taken', config: { name: 'X', steps: [] } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('CONFLICT');
  });

  test('500 surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof globalThis.fetch;
    const r = await createNodeTool.handler({ config: { name: 'X', steps: [] } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
