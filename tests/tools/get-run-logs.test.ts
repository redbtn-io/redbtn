/**
 * Vitest for native tool: get_run_logs
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getRunLogsTool from '../../src/lib/tools/native/get-run-logs';

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

describe('get_run_logs — schema', () => {
  test('requires runId; level enum is debug/info/warn/error', () => {
    expect(getRunLogsTool.description.toLowerCase()).toContain('log');
    expect(getRunLogsTool.inputSchema.required).toEqual(['runId']);
    expect(getRunLogsTool.inputSchema.properties.runId).toBeDefined();
    expect(getRunLogsTool.inputSchema.properties.level.enum).toEqual([
      'debug',
      'info',
      'warn',
      'error',
    ]);
  });

  test('server label is system', () => {
    expect(getRunLogsTool.server).toBe('system');
  });
});

describe('get_run_logs — validation', () => {
  test('missing runId returns isError + VALIDATION', async () => {
    const r = await getRunLogsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('empty runId returns isError + VALIDATION', async () => {
    const r = await getRunLogsTool.handler({ runId: '   ' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('invalid level returns isError + VALIDATION', async () => {
    const r = await getRunLogsTool.handler(
      { runId: 'r', level: 'critical' as never },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/level/);
  });
});

describe('get_run_logs — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mkLog(level: string, message: string, ts = Date.now()): Record<string, unknown> {
    return { level, message, timestamp: ts, generationId: 'r1' };
  }

  test('returns all logs unfiltered when no level passed', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      expect(capturedUrl).toContain('/api/v1/runs/r1/logs');
      return new Response(
        JSON.stringify({
          runId: 'r1',
          count: 4,
          logs: [
            mkLog('debug', 'd1'),
            mkLog('info', 'i1'),
            mkLog('warn', 'w1'),
            mkLog('error', 'e1'),
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await getRunLogsTool.handler({ runId: 'r1' }, makeMockContext());
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.runId).toBe('r1');
    expect(body.count).toBe(4);
    expect(body.totalAvailable).toBe(4);
    expect(body.hasMore).toBe(false);
    expect(body.level).toBeNull();
    expect(body.logs.map((l: { message: string }) => l.message)).toEqual([
      'd1',
      'i1',
      'w1',
      'e1',
    ]);
  });

  test('level=warn returns warn + error only (drops debug + info)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          runId: 'r2',
          count: 4,
          logs: [
            mkLog('debug', 'd1'),
            mkLog('info', 'i1'),
            mkLog('warn', 'w1'),
            mkLog('error', 'e1'),
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await getRunLogsTool.handler(
      { runId: 'r2', level: 'warn' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.count).toBe(2);
    expect(body.logs.map((l: { level: string }) => l.level)).toEqual(['warn', 'error']);
    expect(body.level).toBe('warn');
  });

  test('limit caps the response and sets hasMore:true', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          runId: 'r3',
          count: 5,
          logs: [
            mkLog('info', '1'),
            mkLog('info', '2'),
            mkLog('info', '3'),
            mkLog('info', '4'),
            mkLog('info', '5'),
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await getRunLogsTool.handler(
      { runId: 'r3', limit: 2 },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.count).toBe(2);
    expect(body.totalAvailable).toBe(5);
    expect(body.hasMore).toBe(true);
    expect(body.limit).toBe(2);
    expect(body.logs.map((l: { message: string }) => l.message)).toEqual(['1', '2']);
  });

  test('limit caps at MAX_LIMIT (1000)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ runId: 'r4', logs: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getRunLogsTool.handler(
      { runId: 'r4', limit: 999_999 },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).limit).toBe(1000);
  });

  test('unknown severity entries pass through filter unchanged', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          runId: 'r5',
          logs: [
            mkLog('weird', 'unknown'),
            mkLog('info', 'normal'),
            mkLog('error', 'bad'),
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await getRunLogsTool.handler(
      { runId: 'r5', level: 'warn' },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    // 'weird' has no rank → passes; 'info' < warn → drops; 'error' >= warn → passes.
    expect(body.logs.map((l: { message: string }) => l.message)).toEqual([
      'unknown',
      'bad',
    ]);
  });

  test('forwards bearer + user-id headers from state', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ runId: 'r', logs: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getRunLogsTool.handler(
      { runId: 'r' },
      makeMockContext({ state: { authToken: 'tok-l', userId: 'user-l' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-l');
    expect(capturedHeaders['X-User-Id']).toBe('user-l');
  });

  test('handles route response with no logs array gracefully', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ runId: 'r6' }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getRunLogsTool.handler({ runId: 'r6' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.count).toBe(0);
    expect(body.logs).toEqual([]);
    expect(body.hasMore).toBe(false);
  });
});

describe('get_run_logs — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('404 surfaces status + runId', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        statusText: 'Not Found',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getRunLogsTool.handler(
      { runId: 'run_missing' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(404);
    expect(body.runId).toBe('run_missing');
  });

  test('500 returns error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getRunLogsTool.handler({ runId: 'r' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    }) as unknown as typeof globalThis.fetch;

    const r = await getRunLogsTool.handler({ runId: 'r' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ETIMEDOUT/);
  });

  test('malformed JSON returns isError with parse error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('not-json{{{', { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getRunLogsTool.handler({ runId: 'r' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/Invalid JSON/);
  });
});
