/**
 * Vitest for native tool: cancel_run
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import cancelRunTool from '../../src/lib/tools/native/cancel-run';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1' },
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('cancel_run — schema', () => {
  test('requires runId; reason is optional', () => {
    expect(cancelRunTool.description.toLowerCase()).toContain('cancel');
    expect(cancelRunTool.inputSchema.required).toEqual(['runId']);
    expect(cancelRunTool.inputSchema.properties.runId).toBeDefined();
    expect(cancelRunTool.inputSchema.properties.reason).toBeDefined();
  });

  test('server label is system', () => {
    expect(cancelRunTool.server).toBe('system');
  });
});

describe('cancel_run — validation', () => {
  test('missing runId returns isError + VALIDATION', async () => {
    const r = await cancelRunTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('empty runId returns isError + VALIDATION', async () => {
    const r = await cancelRunTool.handler({ runId: '   ' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('cancel_run — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('clean ACK cancel: returns ok+status=cancelled with worker diagnostics', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      capturedMethod = init?.method ?? 'GET';
      capturedBody = init?.body ? String(init.body) : '';
      return new Response(
        JSON.stringify({
          interrupted: true,
          ack: true,
          runId: 'run_z',
          workerId: 'worker-01',
          currentNodeId: 'planner',
          currentStep: { type: 'neuron', index: 1 },
          neuronCallsCancelled: 2,
          publishedSubscribers: 1,
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await cancelRunTool.handler(
      { runId: 'run_z', reason: 'user clicked stop' },
      makeMockContext(),
    );

    expect(capturedUrl).toContain('/api/v1/runs/run_z/interrupt');
    expect(capturedMethod).toBe('POST');
    expect(JSON.parse(capturedBody).reason).toBe('user clicked stop');

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.runId).toBe('run_z');
    expect(body.status).toBe('cancelled');
    expect(body.ack).toBe(true);
    expect(body.forceKilled).toBe(false);
    expect(body.workerId).toBe('worker-01');
    expect(body.currentNodeId).toBe('planner');
    expect(body.currentStep).toEqual({ type: 'neuron', index: 1 });
    expect(body.neuronCallsCancelled).toBe(2);
    expect(body.reason).toBe('user clicked stop');
  });

  test('force-kill (no worker ACK) still returns ok+status=cancelled with forceKilled:true', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          interrupted: true,
          ack: false,
          forceKilled: true,
          runId: 'run_zombie',
          publishedSubscribers: 0,
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await cancelRunTool.handler({ runId: 'run_zombie' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('cancelled');
    expect(body.ack).toBe(false);
    expect(body.forceKilled).toBe(true);
  });

  test('already-terminal: returns ok with the existing status (no double-cancel)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          interrupted: false,
          runId: 'run_done',
          ack: false,
          alreadyTerminated: 'completed',
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await cancelRunTool.handler({ runId: 'run_done' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('completed');
    expect(body.alreadyTerminated).toBe(true);
  });

  test('already-terminal failed: surfaces failed status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          interrupted: false,
          runId: 'run_failed',
          alreadyTerminated: 'failed',
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await cancelRunTool.handler({ runId: 'run_failed' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).status).toBe('failed');
  });

  test('reason is sanity-capped to 500 chars before send', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body ? String(init.body) : '';
      return new Response(
        JSON.stringify({ interrupted: true, ack: true, runId: 'r' }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const longReason = 'x'.repeat(2000);
    await cancelRunTool.handler({ runId: 'r', reason: longReason }, makeMockContext());
    const body = JSON.parse(capturedBody);
    expect(body.reason.length).toBe(500);
  });

  test('omits reason from body when not provided', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body ? String(init.body) : '';
      return new Response(
        JSON.stringify({ interrupted: true, ack: true, runId: 'r' }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await cancelRunTool.handler({ runId: 'r' }, makeMockContext());
    expect(JSON.parse(capturedBody)).toEqual({});
  });

  test('encodes runId in URL path', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({ interrupted: true, ack: true, runId: 'r' }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await cancelRunTool.handler({ runId: 'has spaces & ?' }, makeMockContext());
    expect(capturedUrl).toContain(encodeURIComponent('has spaces & ?'));
  });

  test('forwards bearer + user-id headers from state', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({ interrupted: true, ack: true, runId: 'r' }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await cancelRunTool.handler(
      { runId: 'r' },
      makeMockContext({ state: { authToken: 'tok-c', userId: 'user-c' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-c');
    expect(capturedHeaders['X-User-Id']).toBe('user-c');
  });
});

describe('cancel_run — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('404 (run not found / TTL expired) surfaces status + runId', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'not found' } }), {
        status: 404,
        statusText: 'Not Found',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await cancelRunTool.handler({ runId: 'gone' }, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(404);
    expect(body.runId).toBe('gone');
  });

  test('403 (foreign run owner) surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Forbidden' } }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await cancelRunTool.handler({ runId: 'theirs' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(403);
  });

  test('500 returns error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await cancelRunTool.handler({ runId: 'r' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const r = await cancelRunTool.handler({ runId: 'r' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });
});
