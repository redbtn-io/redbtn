import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunPublisher } from '../../src/lib/run/run-publisher';
import { RunKeys } from '../../src/lib/run/types';

function makeRedis() {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const published: Array<{ channel: string; message: string }> = [];

  const redis = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
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

function readRunState(values: Map<string, string>, runId: string) {
  return JSON.parse(values.get(RunKeys.state(runId))!);
}

describe('RunPublisher progress heartbeat', () => {
  const originalArchiveDisabled = process.env.ARCHIVE_QUEUE_DISABLED;

  beforeEach(() => {
    process.env.ARCHIVE_QUEUE_DISABLED = 'true';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T17:00:00.000Z'));
  });

  afterEach(() => {
    if (originalArchiveDisabled === undefined) delete process.env.ARCHIVE_QUEUE_DISABLED;
    else process.env.ARCHIVE_QUEUE_DISABLED = originalArchiveDisabled;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refreshes lastProgressAt when output chunks are published', async () => {
    const { redis, values } = makeRedis();
    const automationRunsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const generationsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-publisher-chunk',
      userId: 'user-1',
      automationRunId: 'run-publisher-chunk',
      automationRunsCollection,
      generationsCollection,
    });

    await publisher.init('graph-1', 'Graph 1', {});
    expect(readRunState(values, 'run-publisher-chunk').lastProgressAt).toBe('2026-05-22T17:00:00.000Z');

    vi.setSystemTime(new Date('2026-05-22T17:00:05.000Z'));
    await publisher.chunk('hello');

    expect(readRunState(values, 'run-publisher-chunk').lastProgressAt).toBe('2026-05-22T17:00:05.000Z');
    expect(publisher.getCachedState()?.lastProgressAt).toBe('2026-05-22T17:00:05.000Z');
    expect(automationRunsCollection.updateOne).toHaveBeenCalledTimes(1);
    expect(automationRunsCollection.updateOne).toHaveBeenCalledWith(
      { runId: 'run-publisher-chunk' },
      { $set: { lastProgressAt: new Date('2026-05-22T17:00:05.000Z') } },
    );
    expect(generationsCollection.updateOne).toHaveBeenCalledWith(
      { runId: 'run-publisher-chunk' },
      { $set: { lastProgressAt: new Date('2026-05-22T17:00:05.000Z') } },
    );
  });

  it('refreshes lastProgressAt for node start and node complete events', async () => {
    const { redis, values } = makeRedis();
    const generationsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-publisher-node',
      userId: 'user-1',
      generationsCollection,
    });

    await publisher.init('graph-1', 'Graph 1', {});

    vi.setSystemTime(new Date('2026-05-22T17:00:10.000Z'));
    await publisher.nodeStart('node-1', 'universal', 'Node 1');
    expect(readRunState(values, 'run-publisher-node').lastProgressAt).toBe('2026-05-22T17:00:10.000Z');

    vi.setSystemTime(new Date('2026-05-22T17:00:30.000Z'));
    await publisher.nodeComplete('node-1');
    expect(readRunState(values, 'run-publisher-node').lastProgressAt).toBe('2026-05-22T17:00:30.000Z');
    expect(generationsCollection.updateOne).toHaveBeenCalledTimes(2);
    expect(generationsCollection.updateOne).toHaveBeenLastCalledWith(
      { runId: 'run-publisher-node' },
      { $set: { lastProgressAt: new Date('2026-05-22T17:00:30.000Z') } },
    );
  });

  it('refreshes lastProgressAt for graph lifecycle events', async () => {
    const { redis, values } = makeRedis();
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-publisher-graph',
      userId: 'user-1',
    });

    await publisher.init('graph-1', 'Graph 1', {});

    vi.setSystemTime(new Date('2026-05-22T17:00:07.000Z'));
    await publisher.graphStart(2, 'node-1');
    expect(readRunState(values, 'run-publisher-graph').lastProgressAt).toBe('2026-05-22T17:00:07.000Z');

    vi.setSystemTime(new Date('2026-05-22T17:00:27.000Z'));
    await publisher.graphComplete('node-2', 2);
    expect(readRunState(values, 'run-publisher-graph').lastProgressAt).toBe('2026-05-22T17:00:27.000Z');
  });

  it('refreshes lastProgressAt for node progress step events', async () => {
    const { redis, values } = makeRedis();
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-publisher-node-progress',
      userId: 'user-1',
    });

    await publisher.init('graph-1', 'Graph 1', {});
    await publisher.nodeStart('node-1', 'universal', 'Node 1');

    vi.setSystemTime(new Date('2026-05-22T17:00:12.000Z'));
    await publisher.nodeProgress('node-1', 'step 1 start', { index: 0, total: 2 });
    expect(readRunState(values, 'run-publisher-node-progress').lastProgressAt).toBe('2026-05-22T17:00:12.000Z');

    vi.setSystemTime(new Date('2026-05-22T17:00:18.000Z'));
    await publisher.nodeProgress('node-1', 'step 1 complete', { index: 0, total: 2 });
    expect(readRunState(values, 'run-publisher-node-progress').lastProgressAt).toBe('2026-05-22T17:00:18.000Z');
  });

  it('does not refresh lastProgressAt for status bookkeeping events', async () => {
    const { redis, values } = makeRedis();
    const automationRunsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-publisher-status',
      userId: 'user-1',
      automationRunId: 'run-publisher-status',
      automationRunsCollection,
    });

    await publisher.init('graph-1', 'Graph 1', {});
    vi.setSystemTime(new Date('2026-05-22T17:01:00.000Z'));
    await publisher.status('bookkeeping', 'not real work');

    expect(readRunState(values, 'run-publisher-status').lastProgressAt).toBe('2026-05-22T17:00:00.000Z');
    expect(publisher.getCachedState()?.lastProgressAt).toBe('2026-05-22T17:00:00.000Z');
    expect(automationRunsCollection.updateOne).not.toHaveBeenCalled();
  });

  it('refreshes lastProgressAt for tool execution events', async () => {
    const { redis, values } = makeRedis();
    const automationRunsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-publisher-tool',
      userId: 'user-1',
      automationRunId: 'run-publisher-tool',
      automationRunsCollection,
    });

    await publisher.init('graph-1', 'Graph 1', {});
    vi.setSystemTime(new Date('2026-05-22T17:02:00.000Z'));
    await publisher.toolStart('tool-1', 'ssh_shell', 'native');
    expect(readRunState(values, 'run-publisher-tool').lastProgressAt).toBe('2026-05-22T17:02:00.000Z');

    vi.setSystemTime(new Date('2026-05-22T17:02:30.000Z'));
    await publisher.toolProgress('tool-1', 'stdout', { data: { bytes: 12 } });

    expect(readRunState(values, 'run-publisher-tool').lastProgressAt).toBe('2026-05-22T17:02:30.000Z');
    expect(automationRunsCollection.updateOne).toHaveBeenCalledTimes(2);
  });

  it('refreshes lastProgressAt for tool progress events even without an automationrun mirror', async () => {
    const { redis, values } = makeRedis();
    const generationsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-publisher-tool-progress',
      userId: 'user-1',
      generationsCollection,
    });

    await publisher.init('graph-1', 'Graph 1', {});
    vi.setSystemTime(new Date('2026-05-22T17:02:45.000Z'));
    await publisher.toolStart('tool-1', 'ssh_shell', 'native');

    vi.setSystemTime(new Date('2026-05-22T17:03:15.000Z'));
    await publisher.toolProgress('tool-1', 'stdout', { data: { bytes: 64 } });

    expect(readRunState(values, 'run-publisher-tool-progress').lastProgressAt).toBe('2026-05-22T17:03:15.000Z');
    expect(generationsCollection.updateOne).toHaveBeenLastCalledWith(
      { runId: 'run-publisher-tool-progress' },
      { $set: { lastProgressAt: new Date('2026-05-22T17:03:15.000Z') } },
    );
  });

  it('refreshes lastProgressAt for raw tool output events', async () => {
    const { redis, values } = makeRedis();
    const automationRunsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-publisher-tool-output',
      userId: 'user-1',
      automationRunId: 'run-publisher-tool-output',
      automationRunsCollection,
    });

    await publisher.init('graph-1', 'Graph 1', {});
    vi.setSystemTime(new Date('2026-05-22T17:03:00.000Z'));
    await publisher.publish({
      type: 'tool_output',
      toolId: 'tool-1',
      nodeId: 'node-1',
      data: { chunk: 'hello', stream: 'stdout', totalBytes: 5 },
      timestamp: Date.now(),
    });

    expect(readRunState(values, 'run-publisher-tool-output').lastProgressAt).toBe('2026-05-22T17:03:00.000Z');
    expect(automationRunsCollection.updateOne).toHaveBeenCalledWith(
      { runId: 'run-publisher-tool-output' },
      { $set: { lastProgressAt: new Date('2026-05-22T17:03:00.000Z') } },
    );
  });
});
