/**
 * Vitest for native tool: trigger_automation
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 *
 * Covers all four behavioural modes:
 *   - validation (missing automationId)
 *   - wait:false — fire-and-forget, returns queued runId immediately
 *   - wait:true happy path — polls until terminal status
 *   - wait:true timeout — returns status:'timeout' without cancelling
 *   - stream-mode automations bypass polling and return session info
 *   - upstream errors (trigger 4xx, polling 4xx, fetch rejection)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import triggerAutomationTool from '../../src/lib/tools/native/trigger-automation';

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

describe('trigger_automation — schema', () => {
  test('requires automationId, exposes input + wait + timeoutMs + pollIntervalMs', () => {
    expect(triggerAutomationTool.description.toLowerCase()).toContain('trigger');
    expect(triggerAutomationTool.inputSchema.required).toEqual(['automationId']);
    expect(triggerAutomationTool.inputSchema.properties.automationId).toBeDefined();
    expect(triggerAutomationTool.inputSchema.properties.input).toBeDefined();
    expect(triggerAutomationTool.inputSchema.properties.wait).toBeDefined();
    expect(triggerAutomationTool.inputSchema.properties.timeoutMs).toBeDefined();
    expect(triggerAutomationTool.inputSchema.properties.pollIntervalMs).toBeDefined();
  });

  test('server label is automation', () => {
    expect(triggerAutomationTool.server).toBe('automation');
  });
});

describe('trigger_automation — validation', () => {
  test('missing automationId returns isError + VALIDATION', async () => {
    const r = await triggerAutomationTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/automationId/);
  });

  test('empty automationId string returns isError + VALIDATION', async () => {
    const r = await triggerAutomationTool.handler(
      { automationId: '   ' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('trigger_automation — wait:false (default)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns queued runId immediately on success', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    let capturedMethod = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      capturedMethod = init?.method ?? 'GET';
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          success: true,
          mode: 'graph',
          runId: 'run_abc_123',
          streamUrl: '/api/v1/runs/run_abc_123/stream',
          run: {
            runId: 'run_abc_123',
            status: 'queued',
            startedAt: '2026-04-27T00:00:00.000Z',
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await triggerAutomationTool.handler(
      { automationId: 'auto_x' },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(capturedUrl).toContain('/api/v1/automations/auto_x/trigger');
    expect(capturedMethod).toBe('POST');
    expect(capturedBody).toEqual({});

    const body = JSON.parse(result.content[0].text);
    expect(body.runId).toBe('run_abc_123');
    expect(body.automationId).toBe('auto_x');
    expect(body.status).toBe('queued');
    expect(body.streamUrl).toBe('/api/v1/runs/run_abc_123/stream');
  });

  test('input override is forwarded in the POST body', async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({ runId: 'run_y', run: { status: 'queued' } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await triggerAutomationTool.handler(
      { automationId: 'auto_y', input: { topic: 'cooking', count: 5 } },
      makeMockContext(),
    );

    expect(capturedBody).toEqual({ input: { topic: 'cooking', count: 5 } });
  });

  test('Authorization header from state.authToken is forwarded', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({ runId: 'run_h', run: { status: 'queued' } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await triggerAutomationTool.handler(
      { automationId: 'auto_h' },
      makeMockContext({ state: { authToken: 'tok-123', userId: 'user-7' } }),
    );

    expect(capturedHeaders['Authorization']).toBe('Bearer tok-123');
    expect(capturedHeaders['X-User-Id']).toBe('user-7');
  });

  test('automationId is URL-encoded in the trigger path', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({ runId: 'run_e', run: { status: 'queued' } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await triggerAutomationTool.handler(
      { automationId: 'has spaces & ?' },
      makeMockContext(),
    );

    expect(capturedUrl).toContain(encodeURIComponent('has spaces & ?'));
  });

  test('missing runId in response returns isError', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await triggerAutomationTool.handler(
      { automationId: 'auto_n' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/runId/);
  });
});

describe('trigger_automation — stream mode', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('stream-mode trigger returns session info regardless of wait', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          mode: 'stream',
          sessionId: 'sess_abc',
          streamId: 'stream_x',
          wsUrl: 'wss://example.com/ws',
          session: {
            sessionId: 'sess_abc',
            automationId: 'auto_stream',
            streamId: 'stream_x',
            status: 'queued',
            input: {},
            startedAt: '2026-04-27T00:00:00.000Z',
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await triggerAutomationTool.handler(
      { automationId: 'auto_stream', wait: true },
      makeMockContext(),
    );

    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.mode).toBe('stream');
    expect(body.sessionId).toBe('sess_abc');
    expect(body.streamId).toBe('stream_x');
    expect(body.wsUrl).toBe('wss://example.com/ws');
    expect(body.status).toBe('queued');
  });
});

describe('trigger_automation — wait:true polling', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('polls until terminal status (completed)', async () => {
    let triggerCalls = 0;
    let pollCalls = 0;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.endsWith('/trigger')) {
        triggerCalls += 1;
        return new Response(
          JSON.stringify({ runId: 'run_poll_1', run: { status: 'queued' } }),
          { status: 200 },
        );
      }
      if (u.includes('/runs/run_poll_1')) {
        pollCalls += 1;
        if (pollCalls === 1) {
          return new Response(
            JSON.stringify({ run: { status: 'running', runId: 'run_poll_1' } }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            run: {
              runId: 'run_poll_1',
              status: 'completed',
              output: { answer: 42 },
              durationMs: 1234,
              startedAt: '2026-04-27T00:00:00.000Z',
              completedAt: '2026-04-27T00:00:01.234Z',
            },
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const r = await triggerAutomationTool.handler(
      { automationId: 'auto_p', wait: true, pollIntervalMs: 250, timeoutMs: 10_000 },
      makeMockContext(),
    );

    expect(triggerCalls).toBe(1);
    expect(pollCalls).toBeGreaterThanOrEqual(2);
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.runId).toBe('run_poll_1');
    expect(body.status).toBe('completed');
    expect(body.output).toEqual({ answer: 42 });
    expect(body.runDurationMs).toBe(1234);
  });

  test('terminal status:failed surfaces as isError:true', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.endsWith('/trigger')) {
        return new Response(
          JSON.stringify({ runId: 'run_f', run: { status: 'queued' } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          run: {
            runId: 'run_f',
            status: 'failed',
            error: 'graph blew up',
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await triggerAutomationTool.handler(
      { automationId: 'auto_f', wait: true, pollIntervalMs: 250 },
      makeMockContext(),
    );

    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe('failed');
    expect(body.error).toBe('graph blew up');
  });

  test('404 on poll keeps polling (run-doc not yet written)', async () => {
    let pollCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.endsWith('/trigger')) {
        return new Response(
          JSON.stringify({ runId: 'run_404', run: { status: 'queued' } }),
          { status: 200 },
        );
      }
      pollCalls += 1;
      if (pollCalls === 1) {
        return new Response(JSON.stringify({ error: 'Run not found' }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          run: { runId: 'run_404', status: 'completed', output: { ok: true } },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await triggerAutomationTool.handler(
      { automationId: 'auto_404', wait: true, pollIntervalMs: 250 },
      makeMockContext(),
    );

    expect(pollCalls).toBeGreaterThanOrEqual(2);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).status).toBe('completed');
  });

  test('timeout returns status:timeout without isError', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.endsWith('/trigger')) {
        return new Response(
          JSON.stringify({ runId: 'run_t', run: { status: 'queued' } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ run: { runId: 'run_t', status: 'running' } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const start = Date.now();
    const r = await triggerAutomationTool.handler(
      {
        automationId: 'auto_t',
        wait: true,
        pollIntervalMs: 250,
        timeoutMs: 1500,
      },
      makeMockContext(),
    );
    const elapsed = Date.now() - start;

    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe('timeout');
    expect(body.lastSeenStatus).toBe('running');
    expect(body.runId).toBe('run_t');
    // Should have respected the timeout, with some slack for the trigger call.
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(4000);
  });
});

describe('trigger_automation — upstream errors', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('trigger 400 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Automation is disabled' }), {
        status: 400,
        statusText: 'Bad Request',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await triggerAutomationTool.handler(
      { automationId: 'auto_disabled' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(400);
    expect(body.automationId).toBe('auto_disabled');
  });

  test('trigger 404 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        statusText: 'Not Found',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await triggerAutomationTool.handler(
      { automationId: 'auto_missing' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(404);
  });

  test('fetch rejection surfaces error with phase: trigger', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const r = await triggerAutomationTool.handler(
      { automationId: 'auto_x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toMatch(/ECONNREFUSED/);
    expect(body.phase).toBe('trigger');
  });

  test('500 on poll surfaces status', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.endsWith('/trigger')) {
        return new Response(
          JSON.stringify({ runId: 'run_500', run: { status: 'queued' } }),
          { status: 200 },
        );
      }
      return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
    }) as unknown as typeof globalThis.fetch;

    const r = await triggerAutomationTool.handler(
      { automationId: 'auto_500', wait: true, pollIntervalMs: 250 },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
