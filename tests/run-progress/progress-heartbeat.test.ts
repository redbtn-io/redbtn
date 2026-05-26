import { describe, expect, it, vi } from 'vitest';
import {
  isRunProgressStale,
  readRunProgress,
  touchRunProgress,
} from '../../src/lib/run/progress-heartbeat';
import { RunConfig, RunKeys, createInitialRunState } from '../../src/lib/run/types';

function makeRedis(initialState: Record<string, unknown>) {
  const values = new Map<string, string>();
  const setCalls: Array<{ key: string; value: string; mode: string; ttl: number }> = [];
  values.set(RunKeys.state(String(initialState.runId)), JSON.stringify(initialState));

  return {
    values,
    setCalls,
    redis: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, mode: string, ttl: number) => {
        values.set(key, value);
        setCalls.push({ key, value, mode, ttl });
        return 'OK';
      }),
    },
  };
}

describe('touchRunProgress', () => {
  it('initializes run state with the shared heartbeat contract', () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-initial',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });

    expect(typeof state.lastProgressAt).toBe('string');
    expect(Number.isFinite(Date.parse(state.lastProgressAt!))).toBe(true);
    expect(RunConfig.RUN_PROGRESS_STALE_MS).toBe(30 * 60 * 1000);
  });

  it('writes the same heartbeat instant to Redis run state and automationruns', async () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-1',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });
    const { redis, values, setCalls } = makeRedis(state);
    const now = new Date('2026-05-22T16:00:00.000Z');
    const automationRunsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };

    const result = await touchRunProgress({
      redis: redis as any,
      runId: state.runId,
      automationRunId: state.runId,
      automationRunsCollection,
      now,
    });

    expect(result).toEqual({
      lastProgressAt: now.toISOString(),
      redisUpdated: true,
      automationRunUpdated: true,
      generationUpdated: false,
    });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({
      key: RunKeys.state(state.runId),
      mode: 'EX',
      ttl: RunConfig.STATE_TTL_SECONDS,
    });
    expect(JSON.parse(values.get(RunKeys.state(state.runId))!).lastProgressAt).toBe(now.toISOString());
    expect(automationRunsCollection.updateOne).toHaveBeenCalledWith(
      { runId: state.runId },
      { $set: { lastProgressAt: now } },
    );
  });

  it('updates Redis and skips automationruns when automationRunId is missing', async () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-no-automation',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });
    const { redis, values } = makeRedis(state);
    const automationRunsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };

    const result = await touchRunProgress({
      redis: redis as any,
      runId: state.runId,
      automationRunsCollection,
      now: new Date('2026-05-22T16:01:00.000Z'),
    });

    expect(result.redisUpdated).toBe(true);
    expect(result.automationRunUpdated).toBe(false);
    expect(automationRunsCollection.updateOne).not.toHaveBeenCalled();
    expect(JSON.parse(values.get(RunKeys.state(state.runId))!).lastProgressAt).toBe('2026-05-22T16:01:00.000Z');
  });

  it('writes the same heartbeat instant to Redis run state and generations', async () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-generation',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });
    const { redis, values } = makeRedis(state);
    const now = new Date('2026-05-22T16:01:30.000Z');
    const generationsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };

    const result = await touchRunProgress({
      redis: redis as any,
      runId: state.runId,
      generationId: state.runId,
      generationsCollection,
      now,
    });

    expect(result).toEqual({
      lastProgressAt: now.toISOString(),
      redisUpdated: true,
      automationRunUpdated: false,
      generationUpdated: true,
    });
    expect(JSON.parse(values.get(RunKeys.state(state.runId))!).lastProgressAt).toBe(now.toISOString());
    expect(generationsCollection.updateOne).toHaveBeenCalledWith(
      { runId: state.runId },
      { $set: { lastProgressAt: now } },
    );
  });

  it('throttles generations writes while keeping Redis heartbeats current', async () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-throttled-generation',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });
    const { redis, values } = makeRedis(state);
    const generationsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };

    const first = await touchRunProgress({
      redis: redis as any,
      runId: state.runId,
      generationId: state.runId,
      generationsCollection,
      now: new Date('2026-05-22T16:01:40.000Z'),
    });
    const throttled = await touchRunProgress({
      redis: redis as any,
      runId: state.runId,
      generationId: state.runId,
      generationsCollection,
      now: new Date('2026-05-22T16:01:45.000Z'),
    });
    const afterWindow = await touchRunProgress({
      redis: redis as any,
      runId: state.runId,
      generationId: state.runId,
      generationsCollection,
      now: new Date('2026-05-22T16:01:55.000Z'),
    });

    expect(first.generationUpdated).toBe(true);
    expect(throttled.generationUpdated).toBe(false);
    expect(afterWindow.generationUpdated).toBe(true);
    expect(generationsCollection.updateOne).toHaveBeenCalledTimes(2);
    expect(JSON.parse(values.get(RunKeys.state(state.runId))!).lastProgressAt).toBe('2026-05-22T16:01:55.000Z');
    expect(generationsCollection.updateOne).toHaveBeenLastCalledWith(
      { runId: state.runId },
      { $set: { lastProgressAt: new Date('2026-05-22T16:01:55.000Z') } },
    );
  });

  it('throttles automationruns writes while keeping Redis heartbeats current', async () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-throttled-automationrun',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });
    const { redis, values } = makeRedis(state);
    const automationRunsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };

    const first = await touchRunProgress({
      redis: redis as any,
      runId: state.runId,
      automationRunId: state.runId,
      automationRunsCollection,
      now: new Date('2026-05-22T16:02:00.000Z'),
    });
    const throttled = await touchRunProgress({
      redis: redis as any,
      runId: state.runId,
      automationRunId: state.runId,
      automationRunsCollection,
      now: new Date('2026-05-22T16:02:05.000Z'),
    });
    const afterWindow = await touchRunProgress({
      redis: redis as any,
      runId: state.runId,
      automationRunId: state.runId,
      automationRunsCollection,
      now: new Date('2026-05-22T16:02:15.000Z'),
    });

    expect(first.automationRunUpdated).toBe(true);
    expect(throttled.automationRunUpdated).toBe(false);
    expect(afterWindow.automationRunUpdated).toBe(true);
    expect(automationRunsCollection.updateOne).toHaveBeenCalledTimes(2);
    expect(JSON.parse(values.get(RunKeys.state(state.runId))!).lastProgressAt).toBe('2026-05-22T16:02:15.000Z');
    expect(automationRunsCollection.updateOne).toHaveBeenLastCalledWith(
      { runId: state.runId },
      { $set: { lastProgressAt: new Date('2026-05-22T16:02:15.000Z') } },
    );
  });

  it('uses a fresh current timestamp when now is not supplied', async () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-fresh',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });
    const { redis, values } = makeRedis(state);
    const automationRunsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };

    const before = Date.now();
    const result = await touchRunProgress({
      redis: redis as any,
      runId: state.runId,
      automationRunId: state.runId,
      automationRunsCollection,
    });
    const after = Date.now();

    const redisHeartbeat = JSON.parse(values.get(RunKeys.state(state.runId))!).lastProgressAt;
    const redisTime = Date.parse(redisHeartbeat);
    const resultTime = Date.parse(result.lastProgressAt);
    const mongoDate = (automationRunsCollection.updateOne.mock.calls[0][1] as any).$set.lastProgressAt as Date;

    expect(redisHeartbeat).toBe(result.lastProgressAt);
    expect(redisTime).toBeGreaterThanOrEqual(before);
    expect(redisTime).toBeLessThanOrEqual(after);
    expect(resultTime).toBe(redisTime);
    expect(mongoDate.getTime()).toBe(redisTime);
  });
});

describe('readRunProgress', () => {
  it('reads a fresh heartbeat from Redis run state', async () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-read-fresh',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });
    state.lastProgressAt = '2026-05-22T16:00:00.000Z';
    const { redis } = makeRedis(state);

    const snapshot = await readRunProgress({
      redis: redis as any,
      runId: state.runId,
      now: new Date('2026-05-22T16:10:00.000Z'),
    });

    expect(snapshot).toMatchObject({
      runId: state.runId,
      stateFound: true,
      checkedAt: '2026-05-22T16:10:00.000Z',
      staleAfterMs: RunConfig.RUN_PROGRESS_STALE_MS,
      lastProgressAt: '2026-05-22T16:00:00.000Z',
      lastProgressMs: Date.parse('2026-05-22T16:00:00.000Z'),
      isStale: false,
    });
  });

  it('classifies an old heartbeat as stale using the default stale window', async () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-read-stale',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });
    state.lastProgressAt = '2026-05-22T16:00:00.000Z';
    const { redis } = makeRedis(state);

    const snapshot = await readRunProgress({
      redis: redis as any,
      runId: state.runId,
      now: new Date('2026-05-22T16:30:00.000Z'),
    });

    expect(snapshot.isStale).toBe(true);
  });

  it('supports custom stale windows for callers with stricter liveness rules', async () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-read-custom-window',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });
    state.lastProgressAt = '2026-05-22T16:00:00.000Z';
    const { redis } = makeRedis(state);

    const snapshot = await readRunProgress({
      redis: redis as any,
      runId: state.runId,
      now: new Date('2026-05-22T16:05:00.000Z'),
      staleAfterMs: 4 * 60 * 1000,
    });

    expect(snapshot.staleAfterMs).toBe(4 * 60 * 1000);
    expect(snapshot.isStale).toBe(true);
  });

  it('treats a missing heartbeat as stale', async () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-read-missing-heartbeat',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });
    delete state.lastProgressAt;
    const { redis } = makeRedis(state);

    const snapshot = await readRunProgress({
      redis: redis as any,
      runId: state.runId,
      now: new Date('2026-05-22T16:00:00.000Z'),
    });

    expect(snapshot).toMatchObject({
      runId: state.runId,
      stateFound: true,
      isStale: true,
    });
    expect(snapshot.lastProgressAt).toBeUndefined();
    expect(snapshot.lastProgressMs).toBeUndefined();
  });

  it('treats missing Redis run state as stale', async () => {
    const { redis } = makeRedis({ runId: 'different-run' });

    const snapshot = await readRunProgress({
      redis: redis as any,
      runId: 'missing-run',
      now: new Date('2026-05-22T16:00:00.000Z'),
    });

    expect(snapshot).toEqual({
      runId: 'missing-run',
      stateFound: false,
      checkedAt: '2026-05-22T16:00:00.000Z',
      staleAfterMs: RunConfig.RUN_PROGRESS_STALE_MS,
      isStale: true,
    });
  });

  it('treats unparsable heartbeat values as stale', async () => {
    const state = createInitialRunState({
      runId: 'run-heartbeat-read-invalid',
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph 1',
      input: {},
    });
    state.lastProgressAt = 'not-a-date';
    const { redis } = makeRedis(state);

    const snapshot = await readRunProgress({
      redis: redis as any,
      runId: state.runId,
      now: new Date('2026-05-22T16:00:00.000Z'),
    });

    expect(snapshot.lastProgressAt).toBe('not-a-date');
    expect(snapshot.lastProgressMs).toBeUndefined();
    expect(snapshot.isStale).toBe(true);
  });
});

describe('isRunProgressStale', () => {
  it('returns false when the heartbeat is inside the stale window', () => {
    expect(isRunProgressStale('2026-05-22T16:00:00.000Z', {
      now: new Date('2026-05-22T16:29:59.999Z'),
    })).toBe(false);
  });

  it('returns true for missing, invalid, and stale heartbeats', () => {
    expect(isRunProgressStale(undefined, {
      now: new Date('2026-05-22T16:00:00.000Z'),
    })).toBe(true);
    expect(isRunProgressStale('invalid', {
      now: new Date('2026-05-22T16:00:00.000Z'),
    })).toBe(true);
    expect(isRunProgressStale('2026-05-22T16:00:00.000Z', {
      now: new Date('2026-05-22T16:30:00.000Z'),
    })).toBe(true);
  });
});
