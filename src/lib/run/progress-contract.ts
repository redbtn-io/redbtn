import { RunConfig } from './types';

/**
 * Shared liveness field written by every layer that observes real run progress.
 *
 * Contract:
 * - Redis RunState stores this as an ISO string.
 * - Mongo automationruns stores this as a Date.
 * - Mongo generations stores this as a Date when mirrored by archivers/reapers.
 * - Published run events may carry their own event timestamp, but event emission
 *   refreshes this field in run state rather than replacing this contract.
 */
export interface RunProgressHeartbeat {
  lastProgressAt?: string | Date | number | null;
}

/**
 * Redis run-state view used by watchdogs and active workers.
 */
export interface RedisRunProgressRecord extends RunProgressHeartbeat {
  runId: string;
  status?: string;
}

/**
 * Durable automation-run view used by scheduler concurrency checks and reapers.
 */
export interface AutomationRunProgressRecord extends RunProgressHeartbeat {
  runId?: string;
  automationId?: string;
  status?: string;
}

/**
 * Durable generation archive view used by recovery and diagnostics.
 */
export interface GenerationProgressRecord extends RunProgressHeartbeat {
  runId?: string;
  generationId?: string;
  status?: string;
}

export type RunProgressReadableRecord =
  | RedisRunProgressRecord
  | AutomationRunProgressRecord
  | GenerationProgressRecord;

export interface RunProgressStalenessOptions {
  now?: Date;
  staleAfterMs?: number;
}

export interface RunProgressStalenessResult {
  checkedAt: string;
  staleAfterMs: number;
  lastProgressAt?: string;
  lastProgressMs?: number;
  isStale: boolean;
}

export function normalizeLastProgressAt(value: RunProgressHeartbeat['lastProgressAt']): string | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : undefined;
  }

  if (typeof value === 'string') {
    return Number.isFinite(Date.parse(value)) ? value : undefined;
  }

  return undefined;
}

/**
 * Classify any heartbeat-bearing record with the shared stale-window default.
 * Missing, null, and unparsable heartbeats are stale because they do not prove
 * that the run is alive.
 */
export function classifyRunProgressStaleness(
  record: RunProgressHeartbeat | undefined | null,
  options: RunProgressStalenessOptions = {},
): RunProgressStalenessResult {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? RunConfig.RUN_PROGRESS_STALE_MS;
  const lastProgressAt = normalizeLastProgressAt(record?.lastProgressAt);
  const lastProgressMs = lastProgressAt ? Date.parse(lastProgressAt) : NaN;
  const isStale = !Number.isFinite(lastProgressMs) || now.getTime() - lastProgressMs >= staleAfterMs;

  return {
    checkedAt: now.toISOString(),
    staleAfterMs,
    lastProgressAt,
    lastProgressMs: Number.isFinite(lastProgressMs) ? lastProgressMs : undefined,
    isStale,
  };
}
