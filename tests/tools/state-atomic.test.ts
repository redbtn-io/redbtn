/**
 * Vitest for native tool: state_atomic
 *
 * The handler talks to the webapp's POST /api/v1/state/.../values/:key/atomic.
 * fetch is mocked so the suite is deterministic and offline; the server-side
 * atomicity is covered by the webapp's real-Mongo tests.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import stateAtomicTool from '../../src/lib/tools/native/state-atomic';
import { DATA_TOOL_RULES } from '../../src/lib/permissions/tool-map';
import { MCP_EXPOSED_TOOLS } from '../../src/lib/tools/native-registry';

function ctx(): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'u1', authToken: 'tok' },
    runId: 'test-run',
    nodeId: 'test-node',
    toolId: 'test-tool',
    abortSignal: null,
  };
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('state_atomic — schema & registration', () => {
  test('declares its inputs', () => {
    expect(stateAtomicTool.server).toBe('state');
    expect(stateAtomicTool.inputSchema.required).toEqual(['namespace', 'key', 'op']);
    expect(stateAtomicTool.inputSchema.properties.op.enum).toEqual([
      'read',
      'setIfAbsent',
      'heartbeat',
      'release',
      'compareAndSet',
      'increment',
    ]);
  });

  test('is gated as a state write and exposed over MCP', () => {
    expect(DATA_TOOL_RULES.state_atomic).toMatchObject({ resource: 'state', action: 'write' });
    expect(DATA_TOOL_RULES.state_atomic.extract({ namespace: 'locks' })).toMatchObject({ addresses: ['locks'] });
    expect(MCP_EXPOSED_TOOLS.has('state_atomic')).toBe(true);
  });
});

describe('state_atomic — requests', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalUrl: string | undefined;
  let calls: Array<{ url: string; init: RequestInit }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalUrl = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = originalUrl;
  });

  function respond(status: number, body: unknown) {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  }

  test('setIfAbsent posts the claim and forwards only its fields', async () => {
    respond(200, { success: true, won: true, holder: 'h1', value: { run: 1 }, version: 1, expiresAt: null });
    const r = await stateAtomicTool.handler(
      { namespace: 'locks', key: 'model_opus', op: 'setIfAbsent', value: { run: 1 }, ttlMs: 30000, holder: 'h1', by: 9 },
      ctx(),
    );
    expect(r.isError).toBeFalsy();
    expect(parse(r)).toMatchObject({ won: true, holder: 'h1' });
    expect(calls[0].url).toBe('http://test-webapp.example/api/v1/state/namespaces/locks/values/model_opus/atomic');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ op: 'setIfAbsent', value: { run: 1 }, ttlMs: 30000, holder: 'h1' });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['X-User-Id']).toBe('u1');
  });

  test('a lost claim is a normal result, not an error', async () => {
    respond(200, { success: true, won: false, holder: 'other' });
    const r = await stateAtomicTool.handler({ namespace: 'locks', key: 'k', op: 'setIfAbsent', value: 1 }, ctx());
    expect(r.isError).toBeFalsy();
    expect(parse(r)).toMatchObject({ won: false, holder: 'other' });
  });

  test('compareAndSet forwards expected: null explicitly', async () => {
    respond(200, { swapped: true });
    await stateAtomicTool.handler({ namespace: 'n', key: 'k', op: 'compareAndSet', value: 2, expected: null }, ctx());
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ op: 'compareAndSet', value: 2, expected: null });
  });

  test('increment and read', async () => {
    respond(200, { value: 3 });
    await stateAtomicTool.handler({ namespace: 'n', key: 'spend', op: 'increment', by: 2, initial: 1 }, ctx());
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ op: 'increment', by: 2, initial: 1 });
    await stateAtomicTool.handler({ namespace: 'n', key: 'spend', op: 'read', value: 'ignored' }, ctx());
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ op: 'read' });
  });

  test('upstream errors are surfaced with the state error envelope', async () => {
    respond(422, { error: 'Key "k" holds a string, not a number; cannot increment.', code: 'not_a_number' });
    const r = await stateAtomicTool.handler({ namespace: 'n', key: 'k', op: 'increment' }, ctx());
    expect(r.isError).toBe(true);
    expect(parse(r)).toMatchObject({ status: 422, details: { code: 'not_a_number' } });
  });
});

describe('state_atomic — validation (no request made)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['missing namespace', { key: 'k', op: 'read' }],
    ['missing key', { namespace: 'n', op: 'read' }],
    ['unknown op', { namespace: 'n', key: 'k', op: 'lock' }],
    ['setIfAbsent without value', { namespace: 'n', key: 'k', op: 'setIfAbsent' }],
    ['heartbeat without holder', { namespace: 'n', key: 'k', op: 'heartbeat', ttlMs: 10 }],
    ['heartbeat without ttlMs', { namespace: 'n', key: 'k', op: 'heartbeat', holder: 'h' }],
    ['release without holder', { namespace: 'n', key: 'k', op: 'release' }],
    ['compareAndSet with neither comparand', { namespace: 'n', key: 'k', op: 'compareAndSet', value: 1 }],
    ['compareAndSet with both comparands', { namespace: 'n', key: 'k', op: 'compareAndSet', value: 1, expected: 1, expectedVersion: 1 }],
  ];
  for (const [name, args] of cases) {
    test(name, async () => {
      const fetchSpy = vi.fn();
      const original = globalThis.fetch;
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      try {
        const r = await stateAtomicTool.handler(args, ctx());
        expect(r.isError).toBe(true);
        expect(parse(r).code).toBe('VALIDATION');
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = original;
      }
    });
  }
});
