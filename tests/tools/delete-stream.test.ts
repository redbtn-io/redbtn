/**
 * Vitest for native tool: delete_stream
 *
 * Critical: REFUSES isSystem streams (SYSTEM_ASSET_PROTECTED). Note that
 * unlike graphs and nodes, streams have no fork API — the remediation
 * message tells the agent to recreate via create_stream instead.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import deleteStreamTool from '../../src/lib/tools/native/delete-stream';

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

describe('delete_stream — schema', () => {
  test('streamId required', () => {
    expect(deleteStreamTool.server).toBe('platform');
    expect(deleteStreamTool.inputSchema.required).toEqual(['streamId']);
  });
});

describe('delete_stream — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('deletes user-owned stream after isSystem check passes', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const method = init?.method || 'GET';
      calls.push({ url, method });
      if (method === 'GET') {
        return new Response(
          JSON.stringify({ stream: { streamId: 's1', userId: 'user-abc', isSystem: false } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteStreamTool.handler({ streamId: 's1' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, streamId: 's1' });
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe('DELETE');
  });
});

describe('delete_stream — system asset protection', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('REFUSES isSystem: true (never calls DELETE)', async () => {
    let deleteCalled = false;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'GET') {
        return new Response(JSON.stringify({ stream: { streamId: 'sys-stream', userId: 'system', isSystem: true } }), { status: 200 });
      }
      deleteCalled = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteStreamTool.handler({ streamId: 'sys-stream' }, makeMockContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.code).toBe('SYSTEM_ASSET_PROTECTED');
    expect(parsed.error).toMatch(/create_stream/);
    expect(deleteCalled).toBe(false);
  });
});

describe('delete_stream — validation errors', () => {
  test('missing streamId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await deleteStreamTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('delete_stream — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; process.env.WEBAPP_URL = 'http://test-webapp.example'; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  test('peek 401 surfaces UNAUTHORIZED', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof globalThis.fetch;
    const r = await deleteStreamTool.handler({ streamId: 's1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UNAUTHORIZED');
  });

  test('delete 500 (after passing isSystem) surfaces UPSTREAM_ERROR', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'GET') {
        return new Response(JSON.stringify({ stream: { streamId: 's1', isSystem: false } }), { status: 200 });
      }
      return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
    }) as unknown as typeof globalThis.fetch;
    const r = await deleteStreamTool.handler({ streamId: 's1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('UPSTREAM_ERROR');
  });
});
