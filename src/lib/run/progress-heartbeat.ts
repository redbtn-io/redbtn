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
}

export interface TouchRunProgressResult {
  lastProgressAt: string;
  redisUpdated: boolean;
  automationRunUpdated: boolean;
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
    try {
      const result = await options.automationRunsCollection.updateOne(
        { runId: options.automationRunId },
        { $set: { lastProgressAt: now } },
      );
      automationRunUpdated = (result.matchedCount ?? 0) > 0 || (result.modifiedCount ?? 0) > 0;
    } catch (error) {
      console.warn(
        `[run-progress] Failed to update automationrun heartbeat for ${options.automationRunId}:`,
        error,
      );
    }
  }

  return { lastProgressAt, redisUpdated, automationRunUpdated };
}
