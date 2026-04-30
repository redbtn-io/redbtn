/**
 * Vitest for native tool: create_neuron
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import createNeuronTool from '../../src/lib/tools/native/create-neuron';

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

describe('create_neuron — schema', () => {
  test('config required, server is platform', () => {
    expect(createNeuronTool.server).toBe('platform');
    expect(createNeuronTool.inputSchema.required).toEqual(['config']);
  });
});

describe('create_neuron — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('returns neuronId + name + provider + model on 201', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/neurons');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.name).toBe('Custom GPT-5');
      expect(body.provider).toBe('openai');
      return new Response(
        JSON.stringify({ neuronId: 'n_xyz', name: 'Custom GPT-5', provider: 'openai', model: 'gpt-5', role: 'chat', createdAt: 'now' }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await createNeuronTool.handler(
      { config: { name: 'Custom GPT-5', provider: 'openai', model: 'gpt-5', temperature: 0.5 } },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.neuronId).toBe('n_xyz');
    expect(parsed.provider).toBe('openai');
    expect(parsed.model).toBe('gpt-5');
  });
});

describe('create_neuron — validation errors', () => {
  test('missing config returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await createNeuronTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('create_neuron — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await createNeuronTool.handler({ config: { name: 'X', provider: 'openai', model: 'gpt-5' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('429 surfaces LIMIT_EXCEEDED', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Neuron limit reached' }), { status: 429, statusText: 'Too Many Requests' })) as unknown as typeof globalThis.fetch;
    const r = await createNeuronTool.handler({ config: { name: 'X', provider: 'openai', model: 'gpt-5' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('LIMIT_EXCEEDED');
  });

  test('500 surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof globalThis.fetch;
    const r = await createNeuronTool.handler({ config: { name: 'X', provider: 'openai', model: 'gpt-5' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
