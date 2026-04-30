/**
 * Vitest for native tool: update_stream
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import updateStreamTool from '../../src/lib/tools/native/update-stream';

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

describe('update_stream — schema', () => {
  test('streamId + patch required', () => {
    expect(updateStreamTool.server).toBe('platform');
    expect(updateStreamTool.inputSchema.required).toEqual(['streamId', 'patch']);
  });
});

describe('update_stream — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('returns ok + streamId + updatedAt on 200', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/streams/s1');
      expect(init?.method).toBe('PATCH');
      return new Response(
        JSON.stringify({ success: true, stream: { streamId: 's1', name: 'Renamed', updatedAt: 'now' } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await updateStreamTool.handler({ streamId: 's1', patch: { name: 'Renamed' } }, makeMockContext());
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).ok).toBe(true);
  });
});

describe('update_stream — validation errors', () => {
  test('missing streamId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await updateStreamTool.handler({ patch: {} }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing patch returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await updateStreamTool.handler({ streamId: 's1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('update_stream — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await updateStreamTool.handler({ streamId: 's1', patch: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('403 (member tries owner-only field) surfaces FORBIDDEN', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Owner required' } }), { status: 403, statusText: 'Forbidden' })) as unknown as typeof globalThis.fetch;
    const r = await updateStreamTool.handler({ streamId: 's1', patch: { providerConfig: { temp: 0.5 } } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('FORBIDDEN');
  });

  test('500 surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof globalThis.fetch;
    const r = await updateStreamTool.handler({ streamId: 's1', patch: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
