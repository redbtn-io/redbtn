import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  classifyRunProgressStaleness,
  normalizeLastProgressAt,
  type AutomationRunProgressRecord,
  type GenerationProgressRecord,
  type RedisRunProgressRecord,
  type RunProgressHeartbeat,
  type RunProgressReadableRecord,
  type RunProgressStalenessResult,
} from '../../src/lib/run';
import { RunConfig } from '../../src/lib/run/types';

describe('run progress heartbeat contract', () => {
  it('normalizes the heartbeat formats used by Redis and Mongo readers', () => {
    expect(normalizeLastProgressAt('2026-05-22T16:00:00.000Z')).toBe('2026-05-22T16:00:00.000Z');
    expect(normalizeLastProgressAt(new Date('2026-05-22T16:00:00.000Z'))).toBe('2026-05-22T16:00:00.000Z');
    expect(normalizeLastProgressAt(Date.parse('2026-05-22T16:00:00.000Z'))).toBe('2026-05-22T16:00:00.000Z');
  });

  it('rejects missing, null, invalid, and non-finite heartbeat values', () => {
    expect(normalizeLastProgressAt(undefined)).toBeUndefined();
    expect(normalizeLastProgressAt(null)).toBeUndefined();
    expect(normalizeLastProgressAt('not-a-date')).toBeUndefined();
    expect(normalizeLastProgressAt(Number.NaN)).toBeUndefined();
    expect(normalizeLastProgressAt(new Date('not-a-date'))).toBeUndefined();
  });

  it('classifies fresh and stale records with the shared default window', () => {
    const fresh = classifyRunProgressStaleness(
      { lastProgressAt: '2026-05-22T16:00:00.000Z' },
      { now: new Date('2026-05-22T16:29:59.999Z') },
    );
    const stale = classifyRunProgressStaleness(
      { lastProgressAt: '2026-05-22T16:00:00.000Z' },
      { now: new Date('2026-05-22T16:30:00.000Z') },
    );

    expect(fresh).toEqual({
      checkedAt: '2026-05-22T16:29:59.999Z',
      staleAfterMs: RunConfig.RUN_PROGRESS_STALE_MS,
      lastProgressAt: '2026-05-22T16:00:00.000Z',
      lastProgressMs: Date.parse('2026-05-22T16:00:00.000Z'),
      isStale: false,
    });
    expect(stale.isStale).toBe(true);
  });

  it('treats absent records and absent heartbeat fields as stale', () => {
    expect(classifyRunProgressStaleness(undefined, {
      now: new Date('2026-05-22T16:00:00.000Z'),
    })).toMatchObject({
      lastProgressAt: undefined,
      lastProgressMs: undefined,
      isStale: true,
    });

    expect(classifyRunProgressStaleness({}, {
      now: new Date('2026-05-22T16:00:00.000Z'),
    }).isStale).toBe(true);
  });

  it('supports stricter caller-specific stale windows without changing the contract default', () => {
    const snapshot = classifyRunProgressStaleness(
      { lastProgressAt: new Date('2026-05-22T16:00:00.000Z') },
      {
        now: new Date('2026-05-22T16:05:00.000Z'),
        staleAfterMs: 4 * 60 * 1000,
      },
    );

    expect(snapshot).toMatchObject({
      staleAfterMs: 4 * 60 * 1000,
      lastProgressAt: '2026-05-22T16:00:00.000Z',
      isStale: true,
    });
  });

  it('keeps the Redis, automationruns, and generations record shapes assignable to one readable contract', () => {
    const redisRecord: RedisRunProgressRecord = {
      runId: 'run-1',
      status: 'running',
      lastProgressAt: '2026-05-22T16:00:00.000Z',
    };
    const automationRecord: AutomationRunProgressRecord = {
      runId: 'run-1',
      automationId: 'automation-1',
      status: 'running',
      lastProgressAt: new Date('2026-05-22T16:00:00.000Z'),
    };
    const generationRecord: GenerationProgressRecord = {
      runId: 'run-1',
      generationId: 'run-1',
      status: 'running',
      lastProgressAt: Date.parse('2026-05-22T16:00:00.000Z'),
    };

    const records: RunProgressReadableRecord[] = [redisRecord, automationRecord, generationRecord];

    expect(records.map((record) => classifyRunProgressStaleness(record, {
      now: new Date('2026-05-22T16:01:00.000Z'),
    }).isStale)).toEqual([false, false, false]);
    expectTypeOf(redisRecord).toMatchTypeOf<RunProgressHeartbeat>();
    expectTypeOf(automationRecord).toMatchTypeOf<RunProgressHeartbeat>();
    expectTypeOf(generationRecord).toMatchTypeOf<RunProgressHeartbeat>();
    expectTypeOf(classifyRunProgressStaleness(redisRecord)).toMatchTypeOf<RunProgressStalenessResult>();
  });
});
