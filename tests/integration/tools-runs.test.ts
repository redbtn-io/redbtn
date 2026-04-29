/**
 * Integration test for the native runs pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a small
 * graph using the new tools end-to-end."
 *
 * The three new tools in this pack form a coherent agent lifecycle alongside
 * the existing `get_recent_runs`:
 *
 *    get_run         — fetch the live state of a single run
 *    get_run_logs    — fetch redlog entries for diagnosis
 *    cancel_run      — interrupt an in-flight run with handshake + force-kill
 *
 * All three are HTTP API proxies; we mock at the fetch layer with a single
 * shared mock that routes by URL pattern. This validates:
 *   1. NativeToolRegistry singleton has all 3 new tools registered (alongside
 *      the pre-existing get_recent_runs).
 *   2. A simulated agent flow chains them end-to-end:
 *        get_run (poll, see running) →
 *        get_run_logs (inspect what's happening) →
 *        cancel_run (decide to abort) →
 *        get_run (verify cancelled state)
 *   3. The shared `system` server label is consistent.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';

// Re-import each tool by path. In production, native-registry.ts loads each
// via require('./native/foo.js'); under vitest those .js paths don't exist
// next to the .ts module, so the catch block silently swallows the failure.
// We work around it by importing the TS modules and explicitly re-registering
// them with the singleton.
import getRunTool from '../../src/lib/tools/native/get-run';
import getRunLogsTool from '../../src/lib/tools/native/get-run-logs';
import cancelRunTool from '../../src/lib/tools/native/cancel-run';

const WEBAPP = 'http://test-webapp.example';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-int', authToken: 'tok-int' },
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('runs pack integration — registration + chained execution', () => {
  beforeAll(() => {
    const registry = getNativeRegistry();
    if (!registry.has('get_run')) registry.register('get_run', getRunTool);
    if (!registry.has('get_run_logs')) registry.register('get_run_logs', getRunLogsTool);
    if (!registry.has('cancel_run')) registry.register('cancel_run', cancelRunTool);
  });

  test('NativeToolRegistry has all 3 new runs-pack tools registered', () => {
    const registry = getNativeRegistry();
    for (const name of ['get_run', 'get_run_logs', 'cancel_run']) {
      expect(registry.has(name)).toBe(true);
    }
    for (const name of ['get_run', 'get_run_logs', 'cancel_run']) {
      expect(registry.get(name)?.server).toBe('system');
    }
  });

  describe('end-to-end agent flow: poll → inspect logs → cancel → verify', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      process.env.WEBAPP_URL = WEBAPP;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    test('agent polls a run, inspects its logs, decides to cancel, verifies', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      // Simulated server-side mutable state — a runaway run that the agent
      // decides to cancel after observing it spinning in the logs.
      let runStatus: 'running' | 'cancelled' = 'running';
      let cancelCallCount = 0;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        const method = init?.method ?? 'GET';

        // 1. get_run → GET /api/v1/runs/run_runaway
        if (method === 'GET' && /\/api\/v1\/runs\/run_runaway$/.test(url)) {
          return new Response(
            JSON.stringify({
              runId: 'run_runaway',
              userId: 'user-int',
              status: runStatus,
              graphId: 'graph_loop',
              currentNodeId: 'planner',
              startedAt: '2026-04-27T00:00:00.000Z',
              completedAt: runStatus === 'cancelled' ? '2026-04-27T00:00:30.000Z' : null,
              output: { content: 'thinking...' },
            }),
            { status: 200 },
          );
        }

        // 2. get_run_logs → GET /api/v1/runs/run_runaway/logs
        if (method === 'GET' && url.includes('/api/v1/runs/run_runaway/logs')) {
          return new Response(
            JSON.stringify({
              runId: 'run_runaway',
              count: 5,
              logs: [
                { level: 'info', message: 'Run started', timestamp: 1 },
                { level: 'debug', message: 'Compiled graph', timestamp: 2 },
                { level: 'info', message: 'Entering planner', timestamp: 3 },
                { level: 'warn', message: 'Re-plan loop iteration 5', timestamp: 4 },
                { level: 'warn', message: 'Re-plan loop iteration 6', timestamp: 5 },
              ],
            }),
            { status: 200 },
          );
        }

        // 3. cancel_run → POST /api/v1/runs/run_runaway/interrupt
        if (
          method === 'POST' &&
          url.endsWith('/api/v1/runs/run_runaway/interrupt')
        ) {
          cancelCallCount += 1;
          // First call: clean ACK from worker. Mutates run state to cancelled
          // so the verifying GET reflects reality.
          runStatus = 'cancelled';
          return new Response(
            JSON.stringify({
              interrupted: true,
              ack: true,
              runId: 'run_runaway',
              workerId: 'worker-test',
              currentNodeId: 'planner',
              currentStep: { type: 'neuron', index: 0 },
              neuronCallsCancelled: 1,
              publishedSubscribers: 1,
              reason: 'agent decided runaway',
            }),
            { status: 200 },
          );
        }

        return new Response('not found', { status: 404 });
      }) as unknown as typeof globalThis.fetch;

      // ── 1. get_run — poll for status ─────────────────────────────────────
      const pollResult = await registry.callTool(
        'get_run',
        { runId: 'run_runaway' },
        ctx,
      );
      expect(pollResult.isError).toBeFalsy();
      const pollBody = JSON.parse(pollResult.content[0].text);
      expect(pollBody.run.runId).toBe('run_runaway');
      expect(pollBody.run.status).toBe('running');
      expect(pollBody.run.currentNodeId).toBe('planner');

      // ── 2. get_run_logs — inspect the warn-level entries to spot trouble ──
      const logsResult = await registry.callTool(
        'get_run_logs',
        { runId: 'run_runaway', level: 'warn' },
        ctx,
      );
      expect(logsResult.isError).toBeFalsy();
      const logsBody = JSON.parse(logsResult.content[0].text);
      expect(logsBody.runId).toBe('run_runaway');
      expect(logsBody.count).toBe(2); // two warn entries match level=warn
      expect(logsBody.logs.every((l: { level: string }) => l.level === 'warn')).toBe(
        true,
      );
      // The "Re-plan loop iteration N" pattern is enough signal for the agent
      // to decide to cancel.
      const sawReplanLoop = logsBody.logs.some((l: { message: string }) =>
        l.message.includes('Re-plan loop'),
      );
      expect(sawReplanLoop).toBe(true);

      // ── 3. cancel_run — clean ACK cancel ─────────────────────────────────
      const cancelResult = await registry.callTool(
        'cancel_run',
        { runId: 'run_runaway', reason: 'agent decided runaway' },
        ctx,
      );
      expect(cancelResult.isError).toBeFalsy();
      const cancelBody = JSON.parse(cancelResult.content[0].text);
      expect(cancelBody.ok).toBe(true);
      expect(cancelBody.status).toBe('cancelled');
      expect(cancelBody.ack).toBe(true);
      expect(cancelBody.forceKilled).toBe(false);
      expect(cancelBody.workerId).toBe('worker-test');
      expect(cancelBody.neuronCallsCancelled).toBe(1);
      expect(cancelCallCount).toBe(1);

      // ── 4. get_run — verify the run is now cancelled ─────────────────────
      const verifyResult = await registry.callTool(
        'get_run',
        { runId: 'run_runaway' },
        ctx,
      );
      expect(verifyResult.isError).toBeFalsy();
      const verifyBody = JSON.parse(verifyResult.content[0].text);
      expect(verifyBody.run.status).toBe('cancelled');
      expect(verifyBody.run.completedAt).toBe('2026-04-27T00:00:30.000Z');
    });

    test('cancel_run on already-completed run short-circuits to ok with existing status', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

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

      const r = await registry.callTool('cancel_run', { runId: 'run_done' }, ctx);
      expect(r.isError).toBeFalsy();
      const body = JSON.parse(r.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.status).toBe('completed');
      expect(body.alreadyTerminated).toBe(true);
    });

    test('get_run on TTL-expired run returns 404 isError; agent falls back to get_recent_runs', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Run not found' } }), {
          status: 404,
          statusText: 'Not Found',
        }),
      ) as unknown as typeof globalThis.fetch;

      const r = await registry.callTool(
        'get_run',
        { runId: 'old_run' },
        ctx,
      );
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text);
      expect(body.status).toBe(404);
      expect(body.runId).toBe('old_run');
    });

    test('get_run_logs handles a 403 (foreign run) cleanly', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          statusText: 'Forbidden',
        }),
      ) as unknown as typeof globalThis.fetch;

      const r = await registry.callTool(
        'get_run_logs',
        { runId: 'someones_run' },
        ctx,
      );
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text);
      expect(body.status).toBe(403);
      expect(body.runId).toBe('someones_run');
    });
  });
});
