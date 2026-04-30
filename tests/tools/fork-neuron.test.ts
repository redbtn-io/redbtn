/**
 * Vitest for native tool: fork_neuron
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import forkNeuronTool from '../../src/lib/tools/native/fork-neuron';

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

describe('fork_neuron — schema', () => {
  test('neuronId required', () => {
    expect(forkNeuronTool.server).toBe('platform');
    expect(forkNeuronTool.inputSchema.required).toEqual(['neuronId']);
  });
});

describe('fork_neuron — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('returns neuronId + forkedFrom on 201', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/neurons/red-neuron/fork');
      return new Response(
        JSON.stringify({ success: true, neuronId: 'red-neuron-fork', parentNeuronId: 'red-neuron', name: 'My Red Neuron' }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await forkNeuronTool.handler({ neuronId: 'red-neuron' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.neuronId).toBe('red-neuron-fork');
    expect(parsed.forkedFrom).toBe('red-neuron');
  });
});

describe('fork_neuron — validation errors', () => {
  test('missing neuronId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await forkNeuronTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('fork_neuron — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await forkNeuronTool.handler({ neuronId: 'n1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('429 surfaces LIMIT_EXCEEDED', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Neuron limit reached' }), { status: 429, statusText: 'Too Many Requests' })) as unknown as typeof globalThis.fetch;
    const r = await forkNeuronTool.handler({ neuronId: 'n1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('LIMIT_EXCEEDED');
  });

  test('500 surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof globalThis.fetch;
    const r = await forkNeuronTool.handler({ neuronId: 'n1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
