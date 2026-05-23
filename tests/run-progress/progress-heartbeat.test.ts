import { describe, expect, it, vi } from 'vitest';
import { touchRunProgress } from '../../src/lib/run/progress-heartbeat';
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
