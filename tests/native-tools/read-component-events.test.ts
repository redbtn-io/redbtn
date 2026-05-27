/**
 * Phase 10 — `read_component_events` native tool unit tests.
 *
 * Covers both paths:
 *   - With WEBAPP_URL set: hits GET /api/v1/runs/:runId/component-event via
 *     fetch, surfaces the events JSON in the MCP-style result. ?peek=1 wired
 *     correctly.
 *   - Without WEBAPP_URL: drains the inbox directly via the publisher's
 *     Redis client. Same return shape.
 *   - Refuses when no runId is in context.
 *   - Surfaces HTTP non-2xx + fetch errors as MCP isError results.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import readComponentEventsTool from '../../src/lib/tools/native/read-component-events';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

function makeRedis(initial: Array<Record<string, unknown>> = []) {
  const lists = new Map<string, string[]>();
  lists.set('run:component-events:run-1', initial.map((e) => JSON.stringify(e)));
  return {
    rpush: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    publish: vi.fn(async () => 0),
    lrange: vi.fn(async (key: string) => lists.get(key) ?? []),
    del: vi.fn(async (key: string) => (lists.delete(key) ? 1 : 0)),
    lists,
  };
}

function makeCtx(opts: { runId?: string | null; publisher?: unknown } = {}): NativeToolContext {
  // Distinguish "explicitly null" from "unset" so the validation test can
  // exercise the no-runId branch.
  const runId = 'runId' in opts ? (opts.runId as string | null) : 'run-1';
  return {
    publisher: (opts.publisher ?? null) as unknown as Record<string, unknown> | null,
    state: {},
    runId,
    nodeId: null,
    toolId: null,
    abortSignal: null,
  };
}

beforeEach(() => {
  delete process.env.WEBAPP_URL;
});

afterEach(() => {
  delete process.env.WEBAPP_URL;
  vi.restoreAllMocks();
});

describe('read_component_events — webapp path (WEBAPP_URL set)', () => {
  test('GETs the endpoint without peek by default and surfaces the events', async () => {
    process.env.WEBAPP_URL = 'http://test.local';
    const events = [
      { componentId: 'cmp_a', payload: { x: 1 }, timestamp: '2026-05-27T00:00:01Z' },
      { componentId: 'cmp_b', payload: { y: 2 }, timestamp: '2026-05-27T00:00:02Z' },
    ];
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ events }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await readComponentEventsTool.handler({}, makeCtx());
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.events).toEqual(events);
    expect(payload.count).toBe(2);
    expect(payload.peek).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://test.local/api/v1/runs/run-1/component-event',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('peek:true appends ?peek=1 and forwards events without clearing', async () => {
    process.env.WEBAPP_URL = 'http://test.local';
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ events: [], peek: true }), { status: 200 }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);

    const result = await readComponentEventsTool.handler({ peek: true }, makeCtx());
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.peek).toBe(true);
    const url = (fetchMock.mock.calls[0][0]) as string;
    expect(url).toMatch(/\?peek=1$/);
  });

  test('surfaces a non-2xx as MCP isError + status', async () => {
    process.env.WEBAPP_URL = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch,
    );
    const result = await readComponentEventsTool.handler({}, makeCtx());
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe(403);
  });

  test('surfaces a network error as MCP isError', async () => {
    process.env.WEBAPP_URL = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
    );
    const result = await readComponentEventsTool.handler({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/offline/);
  });
});

describe('read_component_events — fallback path (no WEBAPP_URL)', () => {
  test('drains the inbox via the publisher redis client when WEBAPP_URL is unset', async () => {
    const redis = makeRedis([
      { componentId: 'cmp_x', payload: { picked: 'yes' }, timestamp: 'now' },
    ]);
    const result = await readComponentEventsTool.handler(
      {},
      makeCtx({ publisher: { redis } }),
    );
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].componentId).toBe('cmp_x');
    // Drained — second call sees empty.
    const again = await readComponentEventsTool.handler(
      {},
      makeCtx({ publisher: { redis } }),
    );
    expect(JSON.parse(again.content[0].text).events).toEqual([]);
  });

  test('honours peek:true in the fallback path (does not delete the list)', async () => {
    const redis = makeRedis([{ componentId: 'cmp_p', payload: {}, timestamp: 'now' }]);
    const result = await readComponentEventsTool.handler(
      { peek: true },
      makeCtx({ publisher: { redis } }),
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.events).toHaveLength(1);
    expect(redis.del).not.toHaveBeenCalled();
  });

  test('returns CONFIG error when no redis is reachable and no WEBAPP_URL is set', async () => {
    const result = await readComponentEventsTool.handler({}, makeCtx({ publisher: null }));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('CONFIG');
  });
});

describe('read_component_events — validation', () => {
  test('rejects with VALIDATION when no runId is in context and none is supplied', async () => {
    const result = await readComponentEventsTool.handler(
      {},
      makeCtx({ runId: null }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('VALIDATION');
  });

  test('uses args.runId override when supplied', async () => {
    process.env.WEBAPP_URL = 'http://test.local';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events: [] }), { status: 200 }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);
    await readComponentEventsTool.handler({ runId: 'run-overridden' }, makeCtx({ runId: 'run-from-ctx' }));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/runs/run-overridden/');
  });
});
