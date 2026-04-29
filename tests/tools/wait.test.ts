/**
 * Vitest for native tool: wait
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + abort.
 *
 * The abort path is the load-bearing test here: it verifies that an in-flight
 * `wait` yields immediately when the run-level AbortController fires, without
 * blocking the worker until the timeout completes.
 */

import { describe, test, expect } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import waitTool from '../../src/lib/tools/native/wait';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'test-run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

function callOk(
  args: Record<string, unknown>,
  context?: Partial<NativeToolContext>,
): Promise<{ ok: true; waited: number }> {
  return waitTool.handler(args, makeMockContext(context)).then((r) => {
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0].text);
  });
}

function callErr(
  args: Record<string, unknown>,
  context?: Partial<NativeToolContext>,
) {
  return waitTool.handler(args, makeMockContext(context)).then((r) => {
    expect(r.isError).toBe(true);
    return JSON.parse(r.content[0].text);
  });
}

describe('wait — schema', () => {
  test('exposes the documented inputs', () => {
    expect(waitTool.description.toLowerCase()).toMatch(/sleep|wait|millisecond/);
    expect(waitTool.inputSchema.required).toEqual(['ms']);
    expect(waitTool.inputSchema.properties.ms).toBeDefined();
    expect(waitTool.inputSchema.properties.ms.type).toBe('integer');
    expect(waitTool.inputSchema.properties.ms.minimum).toBe(1);
    expect(waitTool.inputSchema.properties.ms.maximum).toBe(300_000);
    expect(waitTool.server).toBe('utility');
  });
});

describe('wait — happy path', () => {
  test('short wait resolves with { ok: true, waited: ms }', async () => {
    const t0 = Date.now();
    const body = await callOk({ ms: 50 });
    const elapsed = Date.now() - t0;
    expect(body.ok).toBe(true);
    expect(body.waited).toBe(50);
    // Should have waited at least ~the requested time (allow 5ms slack on
    // slow CI). Upper bound is intentionally loose.
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(2000);
  });

  test('1 ms wait works (the documented minimum)', async () => {
    const body = await callOk({ ms: 1 });
    expect(body.ok).toBe(true);
    expect(body.waited).toBe(1);
  });
});

describe('wait — validation errors', () => {
  test('missing ms → VALIDATION', async () => {
    const body = await callErr({});
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/ms is required/i);
  });

  test('non-numeric ms → VALIDATION', async () => {
    const body = await callErr({ ms: 'soon' });
    expect(body.code).toBe('VALIDATION');
  });

  test('non-finite ms → VALIDATION', async () => {
    const body = await callErr({ ms: Number.POSITIVE_INFINITY });
    expect(body.code).toBe('VALIDATION');
  });

  test('non-integer ms → VALIDATION', async () => {
    const body = await callErr({ ms: 12.5 });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/integer/i);
  });

  test('ms below minimum (0) → VALIDATION', async () => {
    const body = await callErr({ ms: 0 });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/between 1 and 300000/i);
  });

  test('ms above maximum (300001) → VALIDATION', async () => {
    const body = await callErr({ ms: 300_001 });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/between 1 and 300000/i);
  });

  test('negative ms → VALIDATION', async () => {
    const body = await callErr({ ms: -1 });
    expect(body.code).toBe('VALIDATION');
  });
});

describe('wait — abort handling', () => {
  test('pre-aborted context.abortSignal returns immediately with isError', async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const body = await callErr(
      { ms: 30_000 }, // would take 30s if not aborted
      { abortSignal: ac.signal },
    );
    const elapsed = Date.now() - t0;
    expect(body.code).toBe('ABORTED');
    expect(body.error).toMatch(/abort/i);
    expect(body.waited).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(500); // should be ~immediate, never anywhere near 30s
  });

  test('abort fired mid-wait short-circuits the sleep', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    const body = await callErr(
      { ms: 30_000 }, // 30s nominal sleep
      { abortSignal: ac.signal },
    );
    const elapsed = Date.now() - t0;
    expect(body.code).toBe('ABORTED');
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2000);
    // Reported `waited` should be roughly the elapsed time (not the full 30s)
    expect(body.waited).toBeLessThan(2000);
  });

  test('state._abortController fallback also aborts the wait', async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const body = await callErr(
      { ms: 30_000 },
      { state: { _abortController: ac } },
    );
    expect(body.code).toBe('ABORTED');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test('un-aborted context completes normally', async () => {
    const ac = new AbortController();
    const body = await callOk({ ms: 20 }, { abortSignal: ac.signal });
    expect(body.ok).toBe(true);
    expect(body.waited).toBe(20);
  });
});
