import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunKeys, RunConfig } from '../../src/lib/run/types';

/**
 * executeWithRunProgressWatchdog must observe the run's AbortSignal.
 *
 * Before this, an interrupted run whose in-flight graph step ignored the abort
 * kept executing under the watchdog (12h cap / 30min no-progress) and its run
 * lock kept being renewed until the step finished on its own.
 */

vi.mock('mongoose', () => ({
  models: {},
  Schema: class Schema {},
  model: () => ({
    findById: () => ({
      lean: async () => null,
    }),
  }),
}));

vi.mock('../../src/lib/graphs/MongoCheckpointer', () => ({
  createMongoCheckpointer: () => ({
    getTuple: vi.fn(async () => null),
  }),
}));

class FakeIORedis {
  subscribe = vi.fn(async () => 1);
  unsubscribe = vi.fn(async () => 1);
  quit = vi.fn(async () => undefined);
  publish = vi.fn(async () => 1);
  on = vi.fn(() => this);
}

vi.mock('ioredis', () => ({
  default: FakeIORedis,
}));

const neverSettles = <T>() => new Promise<T>(() => {});

function makeFakePublisher(opts: { lastProgressAt?: () => string | undefined } = {}) {
  const state: any = {
    status: 'running',
    graphId: 'g',
    graphName: 'G',
    startedAt: Date.now(),
    graph: { nodesExecuted: 1, executionPath: ['n1'], nodeProgress: {} },
    tools: [],
  };
  const publisher: any = {
    id: 'run-unit',
    user: 'user-1',
    redis: {},
    getState: vi.fn(async () => ({ ...state, lastProgressAt: opts.lastProgressAt?.() })),
    getCachedState: vi.fn(() => state),
    interrupt: vi.fn(async () => { state.status = 'interrupted'; }),
    fail: vi.fn(async () => { state.status = 'error'; }),
    complete: vi.fn(async () => { state.status = 'completed'; }),
  };
  return { publisher, state };
}

function okResult(runId = 'run-unit'): any {
  return {
    runId,
    graphId: 'g',
    graphName: 'G',
    status: 'completed',
    content: 'done',
    thinking: '',
    data: {},
    metadata: { startedAt: 0, completedAt: 0, duration: 0, nodesExecuted: 1, executionPath: [] },
  };
}

describe('executeWithRunProgressWatchdog — abort signal', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('startRunAbortWatch rejects with RunInterruptedError carrying the reason, and detaches on stop', async () => {
    const { __test__, RunInterruptedError } = await import('../../src/functions/run');
    const controller = new AbortController();
    const watch = __test__.startRunAbortWatch({ signal: controller.signal });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    controller.abort({ reason: 'user-stop' });
    await expect(watch.promise).rejects.toBeInstanceOf(RunInterruptedError);
    await expect(watch.promise).rejects.toMatchObject({ reason: 'user-stop' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

    const idle = new AbortController();
    const idleWatch = __test__.startRunAbortWatch({ signal: idle.signal });
    idleWatch.stop();
    expect(getEventListeners(idle.signal, 'abort')).toHaveLength(0);
  });

  it('settles as interrupted within ~100ms when a step ignores the abort', async () => {
    const { __test__ } = await import('../../src/functions/run');
    const { publisher } = makeFakePublisher({ lastProgressAt: () => new Date().toISOString() });
    const abortController = new AbortController();
    const operation = vi.fn(() => neverSettles<any>()); // step that never observes the signal

    const pending = __test__.executeWithRunProgressWatchdog(operation, {
      runId: 'run-unit',
      publisher,
      abortController,
      idleTimeoutMs: 30 * 60_000,
      configTimeoutMs: 12 * 60 * 60_000,
    });

    await new Promise((r) => setTimeout(r, 20)); // step is now mid-flight
    const abortedAt = performance.now();
    abortController.abort({ reason: 'user-stop' });
    const result = await pending;
    const elapsed = performance.now() - abortedAt;

    expect(elapsed).toBeLessThan(100);
    expect(result.status).toBe('interrupted');
    expect(result.interruptedReason).toBe('user-stop');
    expect(publisher.interrupt).toHaveBeenCalledTimes(1);
    expect(publisher.interrupt).toHaveBeenCalledWith('user-stop');
    expect(publisher.fail).not.toHaveBeenCalled();
    expect(getEventListeners(abortController.signal, 'abort')).toHaveLength(0);
  });

  it('clears every watchdog timer and the abort listener when interrupted (no leaked handles)', async () => {
    vi.useFakeTimers();
    const { __test__ } = await import('../../src/functions/run');
    const { publisher } = makeFakePublisher({ lastProgressAt: () => new Date().toISOString() });
    const abortController = new AbortController();
    const baseline = vi.getTimerCount();

    const pending = __test__.executeWithRunProgressWatchdog(() => neverSettles<any>(), {
      runId: 'run-unit',
      publisher,
      abortController,
      idleTimeoutMs: 30 * 60_000,
      configTimeoutMs: 12 * 60 * 60_000,
    });
    // progress poll + wall-clock cap are armed while the step runs
    expect(vi.getTimerCount()).toBe(baseline + 2);

    abortController.abort('stop');
    const result = await pending;

    expect(result.status).toBe('interrupted');
    expect(result.interruptedReason).toBe('stop');
    expect(vi.getTimerCount()).toBe(baseline);
    expect(getEventListeners(abortController.signal, 'abort')).toHaveLength(0);
  });

  it('leaves normal completion unaffected and cleans up', async () => {
    vi.useFakeTimers();
    const { __test__ } = await import('../../src/functions/run');
    const { publisher } = makeFakePublisher({ lastProgressAt: () => new Date().toISOString() });
    const abortController = new AbortController();
    const baseline = vi.getTimerCount();
    const expected = okResult();

    const result = await __test__.executeWithRunProgressWatchdog(async () => expected, {
      runId: 'run-unit',
      publisher,
      abortController,
      idleTimeoutMs: 30 * 60_000,
      configTimeoutMs: 12 * 60 * 60_000,
    });

    expect(result).toBe(expected);
    expect(publisher.interrupt).not.toHaveBeenCalled();
    expect(publisher.fail).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(baseline);
    expect(getEventListeners(abortController.signal, 'abort')).toHaveLength(0);
  });

  it('still fires the no-progress timeout as an error (its own abort is not reported as an interrupt)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T18:00:00.000Z'));
    const { __test__ } = await import('../../src/functions/run');
    const startedAt = new Date().toISOString();
    const { publisher } = makeFakePublisher({ lastProgressAt: () => startedAt });
    const abortController = new AbortController();
    const baseline = vi.getTimerCount();

    const pending = __test__.executeWithRunProgressWatchdog(() => neverSettles<any>(), {
      runId: 'run-unit',
      publisher,
      abortController,
      idleTimeoutMs: 100,
      configTimeoutMs: 12 * 60 * 60_000,
    });
    // Poll interval floors at 1s; the first check after that sees a stale heartbeat.
    await vi.advanceTimersByTimeAsync(1_100);
    const result = await pending;

    expect(result.status).toBe('error');
    expect(result.error).toContain('made no progress for 100ms');
    expect(abortController.signal.aborted).toBe(true);
    expect(publisher.fail).toHaveBeenCalledTimes(1);
    expect(publisher.interrupt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(baseline);
    expect(getEventListeners(abortController.signal, 'abort')).toHaveLength(0);
  });

  it('still fires the wall-clock config timeout as an error', async () => {
    vi.useFakeTimers();
    const { __test__ } = await import('../../src/functions/run');
    const { publisher } = makeFakePublisher({ lastProgressAt: () => new Date().toISOString() });
    const abortController = new AbortController();

    const pending = __test__.executeWithRunProgressWatchdog(() => neverSettles<any>(), {
      runId: 'run-unit',
      publisher,
      abortController,
      idleTimeoutMs: 30 * 60_000,
      configTimeoutMs: 200,
    });
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;

    expect(result.status).toBe('error');
    expect(result.error).toContain('exceeded configured timeout of 200ms');
    expect(publisher.interrupt).not.toHaveBeenCalled();
  });
});

// ── End-to-end through run(): lock renewal stops + token-scoped release ─────

function makeRedis() {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const evalCalls: Array<{ script: string; key: string; token: string }> = [];

  const redis = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (values.delete(key)) deleted += 1;
        if (lists.delete(key)) deleted += 1;
      }
      return deleted;
    }),
    eval: vi.fn(async (script: string, _keyCount: number, key: string, token: string) => {
      evalCalls.push({ script, key, token });
      if (values.get(key) !== token) return 0;
      if (script.includes('"del"')) {
        values.delete(key);
      }
      return 1;
    }),
    incr: vi.fn(async (key: string) => {
      const next = Number(values.get(key) ?? '0') + 1;
      values.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async () => 1),
    rpush: vi.fn(async (key: string, value: string) => {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
      return list.length;
    }),
    publish: vi.fn(async () => 1),
    pipeline: vi.fn(() => {
      const ops: Array<() => void> = [];
      const pipeline = {
        rpush: vi.fn((key: string, value: string) => {
          ops.push(() => {
            const list = lists.get(key) ?? [];
            list.push(value);
            lists.set(key, list);
          });
          return pipeline;
        }),
        expire: vi.fn(() => pipeline),
        publish: vi.fn(() => pipeline),
        exec: vi.fn(async () => {
          ops.forEach((op) => op());
          return [];
        }),
      };
      return pipeline;
    }),
  };

  return { redis, values, lists, evalCalls };
}

function makeRed(compiledGraph: any, redis: any) {
  return {
    redis,
    redlog: null,
    memory: null,
    neuronRegistry: null,
    graphRegistry: { getGraph: vi.fn(async () => compiledGraph) },
    callMcpTool: vi.fn(),
  };
}

function eventTypes(lists: Map<string, string[]>, runId: string) {
  return (lists.get(RunKeys.events(runId)) ?? []).map((raw) => JSON.parse(raw).type);
}

describe('run() — interrupt while a step ignores the abort', () => {
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    'ARCHIVE_QUEUE_DISABLED',
    'RUN_PROGRESS_IDLE_TIMEOUT_MS',
    'RUN_PROGRESS_WATCHDOG_INTERVAL_MS',
    'RUN_DISABLE_INTERRUPT_SUBSCRIBER',
  ];

  beforeEach(() => {
    for (const k of envKeys) saved[k] = process.env[k];
    process.env.ARCHIVE_QUEUE_DISABLED = 'true';
    process.env.RUN_DISABLE_INTERRUPT_SUBSCRIBER = 'true';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T18:00:00.000Z'));
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('settles interrupted promptly, stops lock renewal, releases with the held token, and publishes one terminal event', async () => {
    const { run } = await import('../../src/functions/run');
    const { runControlRegistry } = await import('../../src/lib/run/RunControlRegistry');
    const { redis, values, lists, evalCalls } = makeRedis();
    const runId = 'run-abort-ignored';
    const conversationId = 'conv-abort-ignored';
    const lockKey = RunKeys.lock(conversationId);

    // A step that ignores the abort entirely and only finishes after 10 minutes.
    let finishStep: (() => void) | null = null;
    const compiledGraph = {
      config: {
        name: 'Stubborn Graph',
        progressIdleTimeoutMs: 60 * 60_000,
        nodes: [{ id: 'respond' }],
      },
      graph: {
        streamEvents: vi.fn(() => ({
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise((resolve) => {
                finishStep = () => resolve({ done: true, value: undefined });
                setTimeout(finishStep, 10 * 60_000);
              }),
            };
          },
        })),
      },
    };

    const result = await run(makeRed(compiledGraph, redis) as any, { message: 'go' }, {
      userId: 'user-1',
      graphId: 'graph-stubborn',
      runId,
      conversationId,
      stream: true,
    });
    const completion = 'completion' in result ? result.completion : Promise.reject(new Error('not streaming'));
    const heldToken = values.get(lockKey);
    expect(heldToken).toBeTruthy();

    // Let a couple of renewals happen while the step is running.
    await vi.advanceTimersByTimeAsync(RunConfig.LOCK_RENEWAL_INTERVAL_MS * 2);
    const isRenewal = (c: { script: string; key: string }) => c.key === lockKey && c.script.includes('"expire"');
    const renewalsBefore = evalCalls.filter(isRenewal).length;
    expect(renewalsBefore).toBeGreaterThanOrEqual(2);

    runControlRegistry.cancel(runId, 'user-stop');
    await vi.advanceTimersByTimeAsync(50);
    const completed = await completion;

    expect(completed.status).toBe('interrupted');
    expect(completed.interruptedReason).toBe('user-stop');
    // Lock released through the normal settle path, token-scoped.
    expect(values.has(lockKey)).toBe(false);
    const releases = evalCalls.filter((c) => c.key === lockKey && c.script.includes('"del"'));
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ key: lockKey, token: heldToken });
    expect(redis.del).not.toHaveBeenCalledWith(lockKey);
    expect(runControlRegistry.get(runId)).toBeUndefined();

    // Renewal stopped: no further renew attempts even though the step is still running.
    await vi.advanceTimersByTimeAsync(RunConfig.LOCK_RENEWAL_INTERVAL_MS * 3);
    expect(evalCalls.filter(isRenewal).length).toBe(renewalsBefore);

    // The orphaned step finishing later must not publish a second terminal verdict.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.runOnlyPendingTimersAsync();
    const types = eventTypes(lists, runId);
    expect(types.filter((t) => t === 'run_interrupted')).toHaveLength(1);
    expect(types).not.toContain('run_complete');
    expect(types).not.toContain('run_error');
  });
});
