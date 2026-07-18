import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunKeys } from '../../src/lib/run/types';

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

function makeRedis() {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const published: Array<{ channel: string; message: string }> = [];

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
    eval: vi.fn(async (_script: string, _keyCount: number, key: string, token: string) => {
      if (values.get(key) === token) {
        values.delete(key);
        return 1;
      }
      return 0;
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
    publish: vi.fn(async (channel: string, message: string) => {
      published.push({ channel, message });
      return 1;
    }),
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
        publish: vi.fn((channel: string, message: string) => {
          ops.push(() => published.push({ channel, message }));
          return pipeline;
        }),
        exec: vi.fn(async () => {
          ops.forEach((op) => op());
          return [];
        }),
      };
      return pipeline;
    }),
  };

  return { redis, values, lists, published };
}

function makeRed(compiledGraph: any, redis: any) {
  return {
    redis,
    redlog: null,
    memory: null,
    neuronRegistry: null,
    graphRegistry: {
      getGraph: vi.fn(async () => compiledGraph),
    },
    callMcpTool: vi.fn(),
  };
}

function readState(values: Map<string, string>, runId: string) {
  return JSON.parse(values.get(RunKeys.state(runId))!);
}

function eventTypes(lists: Map<string, string[]>, runId: string) {
  return (lists.get(RunKeys.events(runId)) ?? []).map((raw) => JSON.parse(raw).type);
}

describe('run progress watchdog', () => {
  const originalArchiveDisabled = process.env.ARCHIVE_QUEUE_DISABLED;
  const originalIdle = process.env.RUN_PROGRESS_IDLE_TIMEOUT_MS;
  const originalInterval = process.env.RUN_PROGRESS_WATCHDOG_INTERVAL_MS;
  const originalConfigTimeout = process.env.RUN_CONFIG_TIMEOUT_MS;
  const originalDisableInterrupt = process.env.RUN_DISABLE_INTERRUPT_SUBSCRIBER;

  beforeEach(() => {
    process.env.ARCHIVE_QUEUE_DISABLED = 'true';
    process.env.RUN_PROGRESS_IDLE_TIMEOUT_MS = '100';
    process.env.RUN_PROGRESS_WATCHDOG_INTERVAL_MS = '25';
    process.env.RUN_DISABLE_INTERRUPT_SUBSCRIBER = 'true';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T18:00:00.000Z'));
  });

  afterEach(() => {
    if (originalArchiveDisabled === undefined) delete process.env.ARCHIVE_QUEUE_DISABLED;
    else process.env.ARCHIVE_QUEUE_DISABLED = originalArchiveDisabled;
    if (originalIdle === undefined) delete process.env.RUN_PROGRESS_IDLE_TIMEOUT_MS;
    else process.env.RUN_PROGRESS_IDLE_TIMEOUT_MS = originalIdle;
    if (originalInterval === undefined) delete process.env.RUN_PROGRESS_WATCHDOG_INTERVAL_MS;
    else process.env.RUN_PROGRESS_WATCHDOG_INTERVAL_MS = originalInterval;
    if (originalConfigTimeout === undefined) delete process.env.RUN_CONFIG_TIMEOUT_MS;
    else process.env.RUN_CONFIG_TIMEOUT_MS = originalConfigTimeout;
    if (originalDisableInterrupt === undefined) delete process.env.RUN_DISABLE_INTERRUPT_SUBSCRIBER;
    else process.env.RUN_DISABLE_INTERRUPT_SUBSCRIBER = originalDisableInterrupt;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fails a wedged streaming iterator, emits terminal events, and releases the lock', async () => {
    const { run } = await import('../../src/functions/run');
    const { redis, values, lists } = makeRedis();
    let observedRunSignal: AbortSignal | null = null;
    const compiledGraph = {
      config: {
        name: 'Wedged Graph',
        progressIdleTimeoutMs: 100,
        nodes: [{ id: 'start' }],
      },
      graph: {
        streamEvents: vi.fn((initialState: any) => {
          observedRunSignal = initialState._abortController.signal;
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise(() => {}),
              };
            },
          };
        }),
      },
    };

    const result = await run(makeRed(compiledGraph, redis) as any, { message: 'go' }, {
      userId: 'user-1',
      graphId: 'graph-wedged',
      runId: 'run-wedged',
      conversationId: 'conv-wedged',
      stream: true,
    });
    const completion = 'completion' in result ? result.completion : Promise.reject(new Error('not streaming'));

    await vi.advanceTimersByTimeAsync(100);
    const completed = await completion;

    expect(completed.status).toBe('error');
    expect(completed.error).toContain('made no progress');
    expect(readState(values, 'run-wedged').status).toBe('error');
    expect(eventTypes(lists, 'run-wedged')).toContain('run_error');
    expect(eventTypes(lists, 'run-wedged')).toContain('run_failed');
    expect(observedRunSignal?.aborted).toBe(true);
    expect(String((observedRunSignal as AbortSignal).reason?.reason)).toContain('made no progress');
    expect(values.has(RunKeys.lock('conv-wedged'))).toBe(false);
  });

  it('does not kill a streaming run whose output keeps heartbeating', async () => {
    const { run } = await import('../../src/functions/run');
    const { redis, values } = makeRedis();
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const compiledGraph = {
      config: {
        name: 'Healthy Graph',
        progressIdleTimeoutMs: 100,
        nodes: [{ id: 'respond' }],
      },
      graph: {
        streamEvents: vi.fn(async function* () {
          await wait(40);
          yield {
            event: 'on_llm_stream',
            metadata: { langgraph_node: 'respond' },
            data: { chunk: { content: 'h' } },
          };
          await wait(40);
          yield {
            event: 'on_llm_stream',
            metadata: { langgraph_node: 'respond' },
            data: { chunk: { content: 'i' } },
          };
          yield {
            event: 'on_chain_end',
            name: 'LangGraph',
            data: { output: { data: { response: 'hi' } } },
          };
        }),
      },
    };

    const result = await run(makeRed(compiledGraph, redis) as any, { message: 'go' }, {
      userId: 'user-1',
      graphId: 'graph-healthy',
      runId: 'run-healthy',
      stream: true,
    });
    const completion = 'completion' in result ? result.completion : Promise.reject(new Error('not streaming'));

    await vi.advanceTimersByTimeAsync(250);
    const completed = await completion;

    expect(completed.status).toBe('completed');
    expect(completed.content).toContain('hi');
    expect(readState(values, 'run-healthy').status).toBe('completed');
    expect(values.has(RunKeys.lock('run-healthy'))).toBe(false);
  });

  it('enforces graph config.timeout as an absolute backstop and releases the lock', async () => {
    const { run } = await import('../../src/functions/run');
    const { redis, values, lists } = makeRedis();
    let observedRunSignal: AbortSignal | null = null;
    const compiledGraph = {
      config: {
        name: 'Timed Graph',
        timeout: 0.1,
        progressIdleTimeoutMs: 10_000,
        nodes: [{ id: 'start' }],
      },
      graph: {
        streamEvents: vi.fn((initialState: any) => {
          observedRunSignal = initialState._abortController.signal;
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise(() => {}),
              };
            },
          };
        }),
      },
    };

    const result = await run(makeRed(compiledGraph, redis) as any, { message: 'go' }, {
      userId: 'user-1',
      graphId: 'graph-timeout',
      runId: 'run-timeout',
      conversationId: 'conv-timeout',
      stream: true,
    });
    const completion = 'completion' in result ? result.completion : Promise.reject(new Error('not streaming'));

    await vi.advanceTimersByTimeAsync(100);
    const completed = await completion;

    expect(completed.status).toBe('error');
    expect(completed.error).toContain('exceeded configured timeout of 100ms');
    expect(readState(values, 'run-timeout').status).toBe('error');
    expect(eventTypes(lists, 'run-timeout')).toContain('run_error');
    expect(eventTypes(lists, 'run-timeout')).toContain('run_failed');
    expect(observedRunSignal?.aborted).toBe(true);
    expect(String((observedRunSignal as AbortSignal).reason?.reason)).toContain('exceeded configured timeout');
    expect(values.has(RunKeys.lock('conv-timeout'))).toBe(false);
  });

  it('uses the default graph timeout when config.timeout is missing', async () => {
    const { run } = await import('../../src/functions/run');
    const { redis, values } = makeRedis();
    process.env.RUN_PROGRESS_WATCHDOG_INTERVAL_MS = '100000';
    process.env.RUN_CONFIG_TIMEOUT_MS = '300000';
    const compiledGraph = {
      config: {
        name: 'Default Timeout Graph',
        progressIdleTimeoutMs: 1_000_000,
        nodes: [{ id: 'start' }],
      },
      graph: {
        streamEvents: vi.fn(() => ({
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise(() => {}),
            };
          },
        })),
      },
    };

    const result = await run(makeRed(compiledGraph, redis) as any, { message: 'go' }, {
      userId: 'user-1',
      graphId: 'graph-default-timeout',
      runId: 'run-default-timeout',
      conversationId: 'conv-default-timeout',
      stream: true,
    });
    const completion = 'completion' in result ? result.completion : Promise.reject(new Error('not streaming'));

    await vi.advanceTimersByTimeAsync(300_000);
    const completed = await completion;

    expect(completed.status).toBe('error');
    expect(completed.error).toContain('exceeded configured timeout of 300000ms');
    expect(readState(values, 'run-default-timeout').status).toBe('error');
    expect(values.has(RunKeys.lock('conv-default-timeout'))).toBe(false);
  });

  it('unsubscribes the interrupt listener after terminal interrupt so late interrupts are ignored', async () => {
    const { run, RunInterruptedError } = await import('../../src/functions/run');
    const { runControlRegistry } = await import('../../src/lib/run/RunControlRegistry');

    const { redis, values } = makeRedis();
    const runId = 'run-interrupt-cleanup';
    const conversationId = 'conv-interrupt-cleanup';
    const compiledGraph = {
      config: {
        name: 'Cleanup Graph',
        progressIdleTimeoutMs: 10_000,
        nodes: [{ id: 'respond' }],
      },
      graph: {
        streamEvents: vi.fn((initialState: any) => {
          const signal = initialState._abortController?.signal;
          let callCount = 0;
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => {
                  callCount += 1;
                  if (callCount === 1) {
                    return Promise.resolve({
                      done: false,
                      value: {
                        event: 'on_llm_stream',
                        metadata: { langgraph_node: 'respond' },
                        data: { chunk: { content: 'x' } },
                      },
                    });
                  }
                  return new Promise((resolve, reject) => {
                    const onAbort = () => {
                      signal?.removeEventListener('abort', onAbort);
                      reject(new RunInterruptedError('tests:timeout'));
                    };
                    signal?.addEventListener('abort', onAbort, { once: true });
                    setTimeout(() => {
                      signal?.removeEventListener('abort', onAbort);
                      resolve({ done: true, value: undefined });
                    }, 5_000);
                  });
                },
              };
            },
          };
        }),
      },
    };

    const result = await run(makeRed(compiledGraph, redis) as any, { message: 'go' }, {
      userId: 'user-1',
      graphId: 'graph-cleanup',
      runId,
      conversationId,
      stream: true,
    });
    const completion = 'completion' in result ? result.completion : Promise.reject(new Error('not streaming'));

    await Promise.resolve();
    runControlRegistry.cancel(runId, 'tests:timeout');
    const completed = await completion;

    expect(completed.status).toBe('interrupted');
    expect(completed.interruptedReason).toBe('tests:timeout');
    expect(values.has(RunKeys.lock(conversationId))).toBe(false);
    expect(runControlRegistry.runIds()).not.toContain(runId);
    expect(runControlRegistry.get(runId)).toBeUndefined();
  });
});
