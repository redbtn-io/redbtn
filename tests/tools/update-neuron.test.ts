/**
 * Vitest for native tool: update_neuron
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import updateNeuronTool from '../../src/lib/tools/native/update-neuron';

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

describe('update_neuron — schema', () => {
  test('neuronId + patch required', () => {
    expect(updateNeuronTool.server).toBe('platform');
    expect(updateNeuronTool.inputSchema.required).toEqual(['neuronId', 'patch']);
  });
});

describe('update_neuron — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('returns ok + updatedAt', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/neurons/n1');
      expect(init?.method).toBe('PATCH');
      return new Response(JSON.stringify({ neuronId: 'n1', name: 'Tuned', updatedAt: 'now' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const r = await updateNeuronTool.handler({ neuronId: 'n1', patch: { temperature: 0.2 } }, makeMockContext());
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).ok).toBe(true);
  });
});

describe('update_neuron — validation errors', () => {
  test('missing neuronId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await updateNeuronTool.handler({ patch: {} }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing patch returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await updateNeuronTool.handler({ neuronId: 'n1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('update_neuron — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await updateNeuronTool.handler({ neuronId: 'n1', patch: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('404 surfaces NOT_FOUND', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Not Found', { status: 404, statusText: 'Not Found' })) as unknown as typeof globalThis.fetch;
    const r = await updateNeuronTool.handler({ neuronId: 'phantom', patch: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('NOT_FOUND');
  });

  test('500 surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof globalThis.fetch;
    const r = await updateNeuronTool.handler({ neuronId: 'n1', patch: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
