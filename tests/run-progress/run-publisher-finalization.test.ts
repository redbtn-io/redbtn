import { describe, expect, it, vi } from 'vitest';
import { RunPublisher } from '../../src/lib/run/run-publisher';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeRedis() {
  const values = new Map<string, string>();
  const published: Array<Record<string, unknown>> = [];

  const redis = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) values.delete(key);
      return keys.length;
    }),
    pipeline: vi.fn(() => {
      const ops: Array<() => void> = [];
      const pipeline = {
        rpush: vi.fn((_key: string, value: string) => {
          ops.push(() => published.push(JSON.parse(value)));
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

  return { redis, published };
}

describe('RunPublisher durable terminal finalization', () => {
  it('awaits guarded durable completion before publishing or logging run_complete', async () => {
    const originalArchiveDisabled = process.env.ARCHIVE_QUEUE_DISABLED;
    process.env.ARCHIVE_QUEUE_DISABLED = 'true';
    const { redis, published } = makeRedis();
    const pendingRunEventWrite = deferred<{ matchedCount: number; modifiedCount: number }>();
    const runEventsCollection = {
      updateOne: vi.fn(() => pendingRunEventWrite.promise),
    };
    const automationRunsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const generationsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const log = { log: vi.fn(async () => undefined) };
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-durable-complete',
      userId: 'user-1',
      automationRunId: 'automation-run-1',
      automationRunsCollection,
      generationsCollection,
      runEventsCollection,
      log: log as any,
    });

    try {
      await publisher.init('graph-1', 'Graph 1', {});
      published.length = 0;
      log.log.mockClear();

      const completion = publisher.complete({ content: 'done' });
      await vi.waitFor(() => expect(runEventsCollection.updateOne).toHaveBeenCalledTimes(1));

      expect(published.some((event) => event.type === 'run_complete')).toBe(false);
      expect(log.log).not.toHaveBeenCalled();

      pendingRunEventWrite.resolve({ matchedCount: 1, modifiedCount: 1 });
      await completion;

      expect(published.some((event) => event.type === 'run_complete')).toBe(true);
      expect(log.log).toHaveBeenCalledTimes(1);
      const completedAt = expect.any(Date);
      expect(runEventsCollection.updateOne).toHaveBeenCalledWith(
        { runId: 'run-durable-complete', status: { $in: ['pending', 'queued', 'running'] } },
        { $set: { status: 'completed', completedAt, updatedAt: completedAt } },
      );
      expect(automationRunsCollection.updateOne).toHaveBeenCalledWith(
        { runId: 'automation-run-1', status: { $in: ['pending', 'queued', 'running'] } },
        { $set: { status: 'completed', completedAt, updatedAt: completedAt } },
      );
      expect(generationsCollection.updateOne).toHaveBeenCalledWith(
        { runId: 'run-durable-complete', status: { $in: ['pending', 'queued', 'running'] } },
        { $set: { status: 'completed', completedAt, updatedAt: completedAt } },
      );
    } finally {
      if (originalArchiveDisabled === undefined) delete process.env.ARCHIVE_QUEUE_DISABLED;
      else process.env.ARCHIVE_QUEUE_DISABLED = originalArchiveDisabled;
    }
  });
});
