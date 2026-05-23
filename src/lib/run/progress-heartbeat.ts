import type { Redis } from 'ioredis';
import { RunConfig, RunKeys, type RunState } from './types';

export interface AutomationRunsCollection {
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount?: number; modifiedCount?: number }>;
}

export interface TouchRunProgressOptions {
  redis: Pick<Redis, 'get' | 'set'>;
  runId: string;
  /**
   * Identifier for the AutomationRun document. In current worker paths this is
   * the AutomationRun.runId value, which is unique and indexed.
   */
  automationRunId?: string;
  automationRunsCollection?: AutomationRunsCollection;
  now?: Date;
  stateTtlSeconds?: number;
  automationRunThrottleMs?: number;
}

export interface TouchRunProgressResult {
  lastProgressAt: string;
  redisUpdated: boolean;
  automationRunUpdated: boolean;
}

const automationRunHeartbeatWrites = new Map<string, number>();

export interface ReadRunProgressOptions {
  redis: Pick<Redis, 'get'>;
  runId: string;
  now?: Date;
  staleAfterMs?: number;
}

export interface RunProgressSnapshot {
  runId: string;
  stateFound: boolean;
  checkedAt: string;
  staleAfterMs: number;
  lastProgressAt?: string;
  lastProgressMs?: number;
  isStale: boolean;
}

export function isRunProgressStale(
  lastProgressAt: string | undefined,
  options: { now?: Date; staleAfterMs?: number } = {},
): boolean {
  const lastProgressMs = lastProgressAt ? Date.parse(lastProgressAt) : NaN;
  if (!Number.isFinite(lastProgressMs)) return true;

  const nowMs = (options.now ?? new Date()).getTime();
  const staleAfterMs = options.staleAfterMs ?? RunConfig.RUN_PROGRESS_STALE_MS;
  return nowMs - lastProgressMs >= staleAfterMs;
}

/**
 * Read a run's liveness heartbeat from Redis and classify it against the
 * shared stale-window default. Missing state, missing lastProgressAt, and
 * unparsable timestamps are all stale because there is no proof of liveness.
 */
export async function readRunProgress(
  options: ReadRunProgressOptions,
): Promise<RunProgressSnapshot> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? RunConfig.RUN_PROGRESS_STALE_MS;
  const rawState = await options.redis.get(RunKeys.state(options.runId));

  if (!rawState) {
    return {
      runId: options.runId,
      stateFound: false,
      checkedAt: now.toISOString(),
      staleAfterMs,
      isStale: true,
    };
  }

  try {
    const state = JSON.parse(rawState) as Partial<RunState>;
    const lastProgressAt =
      typeof state.lastProgressAt === 'string' ? state.lastProgressAt : undefined;
    const lastProgressMs = lastProgressAt ? Date.parse(lastProgressAt) : NaN;

    return {
      runId: options.runId,
      stateFound: true,
      checkedAt: now.toISOString(),
      staleAfterMs,
      lastProgressAt,
      lastProgressMs: Number.isFinite(lastProgressMs) ? lastProgressMs : undefined,
      isStale: isRunProgressStale(lastProgressAt, { now, staleAfterMs }),
    };
  } catch (error) {
    console.warn(`[run-progress] Failed to read Redis heartbeat for ${options.runId}:`, error);
    return {
      runId: options.runId,
      stateFound: true,
      checkedAt: now.toISOString(),
      staleAfterMs,
      isStale: true,
    };
  }
}

/**
 * Refresh the shared liveness heartbeat for a run.
 *
 * Redis is the run-local source used by active workers. Automation runs also
 * get the same instant mirrored to Mongo so scheduler/reaper paths can verify
 * liveness without relying on an in-process worker.
 */
export async function touchRunProgress(
  options: TouchRunProgressOptions,
): Promise<TouchRunProgressResult> {
  const now = options.now ?? new Date();
  const lastProgressAt = now.toISOString();
  const stateKey = RunKeys.state(options.runId);
  let redisUpdated = false;

  const rawState = await options.redis.get(stateKey);
  if (rawState) {
    try {
      const state = JSON.parse(rawState) as RunState;
      state.lastProgressAt = lastProgressAt;
      await options.redis.set(
        stateKey,
        JSON.stringify(state),
        'EX',
        options.stateTtlSeconds ?? RunConfig.STATE_TTL_SECONDS,
      );
      redisUpdated = true;
    } catch (error) {
      console.warn(`[run-progress] Failed to update Redis heartbeat for ${options.runId}:`, error);
    }
  }

  let automationRunUpdated = false;
  if (options.automationRunId && options.automationRunsCollection) {
    const throttleMs = options.automationRunThrottleMs ?? RunConfig.AUTOMATION_RUN_HEARTBEAT_THROTTLE_MS;
    const lastWriteMs = automationRunHeartbeatWrites.get(options.automationRunId) ?? 0;
    const shouldWrite = throttleMs <= 0 || now.getTime() - lastWriteMs >= throttleMs;

    if (shouldWrite) {
      try {
        const result = await options.automationRunsCollection.updateOne(
          { runId: options.automationRunId },
          { $set: { lastProgressAt: now } },
        );
        automationRunUpdated = (result.matchedCount ?? 0) > 0 || (result.modifiedCount ?? 0) > 0;
        if (automationRunUpdated) {
          automationRunHeartbeatWrites.set(options.automationRunId, now.getTime());
        }
      } catch (error) {
        console.warn(
          `[run-progress] Failed to update automationrun heartbeat for ${options.automationRunId}:`,
          error,
        );
      }
    }
  }

  return { lastProgressAt, redisUpdated, automationRunUpdated };
}
