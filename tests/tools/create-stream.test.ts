/**
 * Vitest for native tool: create_stream
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import createStreamTool from '../../src/lib/tools/native/create-stream';

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

describe('create_stream — schema', () => {
  test('config required, server is platform', () => {
    expect(createStreamTool.server).toBe('platform');
    expect(createStreamTool.inputSchema.required).toEqual(['config']);
  });
});

describe('create_stream — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('returns streamId + name + type + status on 201', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/streams');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.name).toBe('Voice Assistant');
      return new Response(
        JSON.stringify({
          success: true,
          stream: {
            streamId: 's_voice_001', name: 'Voice Assistant',
            type: 'provider', status: 'inactive', createdAt: 'now',
          },
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await createStreamTool.handler(
      { config: { name: 'Voice Assistant', type: 'provider', template: 'gemini-live' } },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.streamId).toBe('s_voice_001');
    expect(parsed.type).toBe('provider');
  });
});

describe('create_stream — validation errors', () => {
  test('missing config returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await createStreamTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('create_stream — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await createStreamTool.handler({ config: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('429 surfaces LIMIT_EXCEEDED', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Stream limit reached' } }), { status: 429, statusText: 'Too Many Requests' })) as unknown as typeof globalThis.fetch;
    const r = await createStreamTool.handler({ config: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('LIMIT_EXCEEDED');
  });

  test('500 surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof globalThis.fetch;
    const r = await createStreamTool.handler({ config: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
