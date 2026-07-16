/**
 * Automation Concurrency Limiter
 *
 * Atomic, zombie-aware concurrency control for automation runs. Replaces the
 * old binary `concurrency: 'skip' | 'allow'` knob (cap-1 skip, or unlimited)
 * with a numeric cap enforced at TWO scopes:
 *
 *   - TOTAL       — a cap across ALL of an automation's triggers.
 *   - PER-TRIGGER — an optional per-trigger override, tighter than the total.
 *
 * A new run is admitted only when BOTH the total scope and the applicable
 * per-trigger scope have room. When a scope is at its cap the configured
 * overflow behaviour applies: `skip` (drop the trigger) or `queue` (caller
 * enqueues for later). `allow` never blocks but still tracks the run so the
 * "Active Runs" view stays accurate.
 *
 * # Why this module exists (the 2026-07-15 incident)
 *
 * The coordinator webhook was configured `concurrency: 'allow'` (unlimited). A
 * burst of webhook deliveries spawned 9–17 concurrent runs and OOM-restarted
 * the engine, which mass-interrupted every in-flight run. Two root causes:
 *
 *   1. No numeric cap — `allow` meant literally unlimited.
 *   2. Any read-count-then-start check would have been racy anyway: a thundering
 *      herd of near-simultaneous triggers all read "0 running" before any of
 *      them registers, and all start. So enforcement MUST be atomic.
 *
 * # How it is atomic (requirement 1)
 *
 * Acquisition runs as a single Redis Lua script (`ACQUIRE_LUA`) that prunes
 * zombies, counts, checks both caps, and conditionally registers the new run —
 * all in one indivisible server-side step. Two triggers racing for the last
 * slot cannot both win. Both the total and per-trigger keys carry the same
 * `{automationId}` hash tag so they land in one Redis Cluster slot and the
 * script can mutate both.
 *
 * # How zombies are excluded (requirement 2)
 *
 * Each slot is a sorted-set member (`member = runId`) scored by the run's
 * lastProgressAt heartbeat (epoch ms). A live run refreshes its score via
 * {@link heartbeatAutomationSlot} on every progress event (wired into
 * RunPublisher). Before counting, the acquire script prunes every member whose
 * score is older than the stale window (`ZREMRANGEBYSCORE key -inf cutoff`), so
 * a crashed engine's runs — which stop heartbeating — age out and stop holding
 * slots. This is also the fix for "Active Runs shows phantom runs forever after
 * a crash": {@link countActiveSlots} / {@link listActiveSlots} prune first.
 *
 * The webapp webhook receiver + cron scheduler call {@link tryAcquireAutomationSlot}
 * at TRIGGER time (before creating a run). The engine calls
 * {@link heartbeatAutomationSlot} / {@link releaseAutomationSlot} through
 * RunPublisher during and at the end of the run it executes.
 *
 * @module lib/run/automation-concurrency
 */
import type { Redis } from 'ioredis';
import { RunKeys, RunConfig } from './types';

// =============================================================================
// Config types
// =============================================================================

/**
 * Overflow behaviour when a concurrency scope is at its cap.
 *
 * - `allow`     — never block; run always admitted (still tracked).
 * - `skip`      — drop the trigger; do not start a run.
 * - `queue`     — caller enqueues the trigger to run when a slot frees.
 * - `interrupt` — cancel the in-flight run(s) and start the new one. Pre-existing
 *                 mode; the actual cancellation is the caller's job — the limiter
 *                 admits the run and returns the runIds to interrupt.
 */
export type AutomationConcurrencyMode = 'allow' | 'skip' | 'queue' | 'interrupt';

export const AUTOMATION_CONCURRENCY_MODES: readonly AutomationConcurrencyMode[] = [
  'allow',
  'skip',
  'queue',
  'interrupt',
];

/**
 * Canonical concurrency config stored on an automation (TOTAL scope).
 *
 * `max` is the numeric cap across all triggers. `undefined`/`0`/negative means
 * "no numeric cap" (only meaningful for `allow`; for `skip`/`queue`/`interrupt`
 * a missing max defaults to 1 — see {@link normalizeAutomationConcurrency}).
 */
export interface AutomationConcurrencyConfig {
  mode: AutomationConcurrencyMode;
  max?: number;
}

/**
 * Per-trigger override. Any field omitted inherits the automation-level total
 * config. Accepts the same shapes as the total config plus a bare mode string.
 */
export interface AutomationTriggerConcurrency {
  mode?: AutomationConcurrencyMode;
  max?: number;
}

/**
 * Raw config as it may arrive from the DB / API before normalisation:
 *   - a bare mode string (legacy: `'skip'` / `'allow'` / `'queue'` / `'interrupt'`)
 *   - a `{ mode?, max? }` object (new numeric form)
 *   - `undefined` (no config → defaults to `allow`, unlimited)
 */
export type RawAutomationConcurrency =
  | AutomationConcurrencyMode
  | AutomationConcurrencyConfig
  | AutomationTriggerConcurrency
  | null
  | undefined;

// =============================================================================
// Normalisation
// =============================================================================

const UNLIMITED = -1;

function isMode(v: unknown): v is AutomationConcurrencyMode {
  return typeof v === 'string' && (AUTOMATION_CONCURRENCY_MODES as readonly string[]).includes(v);
}

function coerceMax(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  // Floor to an integer; a max below 1 is meaningless as a positive cap.
  const n = Math.floor(raw);
  return n >= 1 ? n : 0;
}

/**
 * Normalise any raw concurrency value into a canonical
 * {@link AutomationConcurrencyConfig}.
 *
 * Backward compatibility (preserves pre-numeric behaviour exactly):
 *   - `undefined` / `null`         → `{ mode: 'allow' }`               (unlimited)
 *   - `'allow'`                    → `{ mode: 'allow' }`               (unlimited)
 *   - `'skip'` / `'queue'`         → `{ mode, max: 1 }`                (legacy cap-1)
 *   - `'interrupt'`                → `{ mode: 'interrupt', max: 1 }`
 *   - `{ mode, max }`              → validated; mode defaults to `'skip'` when a
 *                                    positive `max` is present, else `'allow'`.
 */
export function normalizeAutomationConcurrency(
  raw: RawAutomationConcurrency,
): AutomationConcurrencyConfig {
  if (raw == null) return { mode: 'allow' };

  if (typeof raw === 'string') {
    if (!isMode(raw)) return { mode: 'allow' };
    if (raw === 'allow') return { mode: 'allow' };
    return { mode: raw, max: 1 };
  }

  const obj = raw as AutomationTriggerConcurrency;
  const max = coerceMax(obj.max);
  const mode: AutomationConcurrencyMode = isMode(obj.mode)
    ? obj.mode
    : max && max >= 1
      ? 'skip'
      : 'allow';

  if (mode === 'allow') return { mode: 'allow' };
  // A blocking mode with no usable numeric max falls back to the legacy cap of 1.
  return { mode, max: max && max >= 1 ? max : 1 };
}

/**
 * The effective numeric cap for a config: a positive integer, or -1 (unlimited)
 * for `allow` mode / a config with no usable cap.
 */
export function effectiveCap(config: AutomationConcurrencyConfig): number {
  if (config.mode === 'allow') return UNLIMITED;
  return typeof config.max === 'number' && config.max >= 1 ? config.max : 1;
}

/**
 * Resolve the two independent scopes that govern one (automation, trigger)
 * admission decision.
 *
 * TOTAL scope always uses the automation-level config. PER-TRIGGER scope uses
 * the trigger override when present; when absent the per-trigger scope is
 * UNLIMITED (only the total cap constrains that trigger). Each scope carries its
 * own overflow mode — a block on the trigger scope reports the trigger's mode
 * (falling back to the total mode), a block on the total scope reports the total
 * mode.
 */
export interface ResolvedConcurrency {
  total: AutomationConcurrencyConfig;
  totalCap: number;
  trigger: AutomationConcurrencyConfig;
  triggerCap: number;
}

export function resolveEffectiveConcurrency(
  totalRaw: RawAutomationConcurrency,
  triggerOverrideRaw?: RawAutomationConcurrency,
): ResolvedConcurrency {
  const total = normalizeAutomationConcurrency(totalRaw);

  let trigger: AutomationConcurrencyConfig;
  let triggerCap: number;
  if (triggerOverrideRaw == null) {
    // No override → the per-trigger scope does not add its own cap; the total
    // cap still applies. Mode falls back to the total mode for reporting.
    trigger = { mode: total.mode, max: total.max };
    triggerCap = UNLIMITED;
  } else {
    const overrideNorm = normalizeAutomationConcurrency(triggerOverrideRaw);
    const max = overrideNorm.max;
    // Did the override name a mode explicitly (string form, or { mode } object)?
    const overrideObj =
      typeof triggerOverrideRaw === 'object' && triggerOverrideRaw !== null
        ? (triggerOverrideRaw as AutomationTriggerConcurrency)
        : undefined;
    const explicitMode: AutomationConcurrencyMode | undefined =
      typeof triggerOverrideRaw === 'string' && isMode(triggerOverrideRaw)
        ? triggerOverrideRaw
        : isMode(overrideObj?.mode)
          ? (overrideObj!.mode as AutomationConcurrencyMode)
          : undefined;
    // Mode precedence: explicit override mode > inherited total mode (when the
    // total itself blocks) > 'skip' when the override sets a positive cap under
    // an 'allow' total (so a per-trigger max is never silently nullified) > 'allow'.
    const mode: AutomationConcurrencyMode =
      explicitMode ??
      (total.mode !== 'allow' ? total.mode : max && max >= 1 ? 'skip' : 'allow');
    trigger = { mode, max };
    triggerCap = effectiveCap({ mode, max });
  }

  return {
    total,
    totalCap: effectiveCap(total),
    trigger,
    triggerCap,
  };
}

// =============================================================================
// Slot identity
// =============================================================================

/** Identifies the concurrency slot a run occupies. */
export interface AutomationConcurrencySlot {
  automationId: string;
  /** Trigger id (automation.triggers[].id). Defaults to `_default`. */
  triggerId?: string;
  /** The run occupying the slot. */
  runId: string;
}

/** Trigger id used when a caller does not supply a discrete one. */
export const DEFAULT_TRIGGER_ID = '_default';

function triggerIdOf(slot: { triggerId?: string }): string {
  const t = typeof slot.triggerId === 'string' ? slot.triggerId.trim() : '';
  return t.length > 0 ? t : DEFAULT_TRIGGER_ID;
}

// =============================================================================
// Admission decision
// =============================================================================

export interface AdmissionDecision {
  /** True when the run may start. */
  allowed: boolean;
  /** What the caller should do. */
  decision: 'allow' | 'skip' | 'queue' | 'interrupt';
  /** Active runs in the total scope AFTER this decision (pruned of zombies). */
  totalActive: number;
  /** Active runs in the per-trigger scope AFTER this decision. */
  triggerActive: number;
  /** Which scope caused a block (undefined when admitted). */
  blockedBy?: 'total' | 'trigger';
  /**
   * For `interrupt` mode: run ids that were already active and should be
   * cancelled by the caller before/while the new run proceeds.
   */
  interruptRunIds?: string[];
}

// =============================================================================
// Lua — atomic acquire
// =============================================================================

/**
 * Atomic acquire. Prunes zombies, checks both caps, conditionally registers.
 *
 * KEYS[1] = total sorted set, KEYS[2] = per-trigger sorted set.
 * ARGV: [now, cutoff, totalMax, triggerMax, member(runId), keyTtl]
 *   - `totalMax` / `triggerMax`: numeric cap, or -1 for unlimited.
 *   - `cutoff`: now - staleMs. Members with score <= cutoff are dead → pruned.
 *
 * Returns [allowed(0|1), totalCount, triggerCount, blockedTrigger(0|1)] where the
 * counts are the post-decision cardinalities. Idempotent for a member that is
 * already registered (re-acquire just refreshes its heartbeat).
 *
 * This is the SINGLE SOURCE OF TRUTH for admission; the FakeRedis in the test
 * suite mirrors this exact algorithm.
 */
export const ACQUIRE_LUA = `
local now = tonumber(ARGV[1])
local cutoff = tonumber(ARGV[2])
local totalMax = tonumber(ARGV[3])
local triggerMax = tonumber(ARGV[4])
local member = ARGV[5]
local ttl = tonumber(ARGV[6])

-- 1) prune zombies (no heartbeat within the stale window) from both scopes
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)

-- 2) idempotent re-acquire: already holding a slot → refresh + allow
if redis.call('ZSCORE', KEYS[1], member) then
  redis.call('ZADD', KEYS[1], now, member)
  redis.call('ZADD', KEYS[2], now, member)
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  return { 1, redis.call('ZCARD', KEYS[1]), redis.call('ZCARD', KEYS[2]), 0 }
end

local totalCount = redis.call('ZCARD', KEYS[1])
local triggerCount = redis.call('ZCARD', KEYS[2])

local totalOk = (totalMax < 0) or (totalCount < totalMax)
local triggerOk = (triggerMax < 0) or (triggerCount < triggerMax)

if totalOk and triggerOk then
  redis.call('ZADD', KEYS[1], now, member)
  redis.call('ZADD', KEYS[2], now, member)
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  return { 1, totalCount + 1, triggerCount + 1, 0 }
end

local blockedTrigger = 0
if not triggerOk then blockedTrigger = 1 end
return { 0, totalCount, triggerCount, blockedTrigger }
`;

// =============================================================================
// Limiter
// =============================================================================

export interface TryAcquireOptions {
  automationId: string;
  triggerId?: string;
  runId: string;
  /** Automation-level (total) concurrency config, raw or normalised. */
  concurrency: RawAutomationConcurrency;
  /** Optional per-trigger override, raw or normalised. */
  triggerConcurrency?: RawAutomationConcurrency;
  /** Injected clock for tests. */
  now?: number;
  /** Override the stale window (defaults to RunConfig.AUTOMATION_CONCURRENCY_STALE_MS). */
  staleMs?: number;
}

/**
 * Redis-backed automation concurrency limiter. All methods are safe to call
 * from any process (webapp API, cron scheduler, engine worker).
 */
export class AutomationConcurrencyLimiter {
  constructor(private readonly redis: Redis) {}

  /**
   * Atomically try to claim a concurrency slot for a run.
   *
   * Call this at TRIGGER time, before creating the run. Returns an
   * {@link AdmissionDecision}: honour `decision` (`allow` → proceed, `skip` →
   * drop, `queue` → enqueue, `interrupt` → cancel `interruptRunIds` then
   * proceed). When `allowed` is false the slot was NOT claimed.
   */
  async tryAcquire(opts: TryAcquireOptions): Promise<AdmissionDecision> {
    const now = opts.now ?? Date.now();
    const staleMs = opts.staleMs ?? RunConfig.AUTOMATION_CONCURRENCY_STALE_MS;
    const cutoff = now - staleMs;
    const triggerId = triggerIdOf(opts);

    const resolved = resolveEffectiveConcurrency(opts.concurrency, opts.triggerConcurrency);

    const totalKey = RunKeys.automationConcurrencyTotal(opts.automationId);
    const triggerKey = RunKeys.automationConcurrencyTrigger(opts.automationId, triggerId);
    const keyTtl = RunConfig.AUTOMATION_CONCURRENCY_KEY_TTL_SECONDS;

    // `interrupt`: admit unconditionally but report who to cancel. We still
    // register the new run so it holds a slot and heartbeats/releases normally.
    if (resolved.total.mode === 'interrupt') {
      const preexisting = await this.listActiveSlots({
        automationId: opts.automationId,
        triggerId,
        now,
        staleMs,
      });
      const res = (await this.redis.eval(
        ACQUIRE_LUA,
        2,
        totalKey,
        triggerKey,
        String(now),
        String(cutoff),
        String(UNLIMITED),
        String(UNLIMITED),
        opts.runId,
        String(keyTtl),
      )) as [number, number, number, number];
      return {
        allowed: true,
        decision: 'interrupt',
        totalActive: Number(res[1]),
        triggerActive: Number(res[2]),
        interruptRunIds: preexisting.filter((r) => r !== opts.runId),
      };
    }

    const res = (await this.redis.eval(
      ACQUIRE_LUA,
      2,
      totalKey,
      triggerKey,
      String(now),
      String(cutoff),
      String(resolved.totalCap),
      String(resolved.triggerCap),
      opts.runId,
      String(keyTtl),
    )) as [number, number, number, number];

    const allowed = Number(res[0]) === 1;
    const totalActive = Number(res[1]);
    const triggerActive = Number(res[2]);

    if (allowed) {
      return { allowed: true, decision: 'allow', totalActive, triggerActive };
    }

    const blockedBy: 'total' | 'trigger' = Number(res[3]) === 1 ? 'trigger' : 'total';
    // The mode that governs overflow is the blocking scope's mode.
    const mode = blockedBy === 'trigger' ? resolved.trigger.mode : resolved.total.mode;
    // `allow` can never block, so a blocked decision is skip or queue.
    const decision: 'skip' | 'queue' = mode === 'queue' ? 'queue' : 'skip';

    return { allowed: false, decision, totalActive, triggerActive, blockedBy };
  }

  /**
   * Refresh a slot's heartbeat (score = now) in both scopes. Update-only
   * (`ZADD XX GT`): never creates a member, never lowers a score. A no-op when
   * the slot was never acquired or has already been released. Called by
   * RunPublisher on every progress event.
   */
  async heartbeat(slot: AutomationConcurrencySlot, now?: number): Promise<void> {
    const ts = now ?? Date.now();
    const triggerId = triggerIdOf(slot);
    const totalKey = RunKeys.automationConcurrencyTotal(slot.automationId);
    const triggerKey = RunKeys.automationConcurrencyTrigger(slot.automationId, triggerId);
    const ttl = RunConfig.AUTOMATION_CONCURRENCY_KEY_TTL_SECONDS;
    // XX = only update existing; GT = only if newer. Keeps heartbeats monotonic
    // and prevents a straggler from resurrecting a released slot.
    await this.redis.zadd(totalKey, 'XX', 'GT', String(ts), slot.runId);
    await this.redis.zadd(triggerKey, 'XX', 'GT', String(ts), slot.runId);
    // Refresh key TTL so long-lived automations don't lose their set to the TTL.
    await this.redis.expire(totalKey, ttl);
    await this.redis.expire(triggerKey, ttl);
  }

  /** Release a slot (both scopes). Idempotent. Called on run terminal. */
  async release(slot: AutomationConcurrencySlot): Promise<void> {
    const triggerId = triggerIdOf(slot);
    const totalKey = RunKeys.automationConcurrencyTotal(slot.automationId);
    const triggerKey = RunKeys.automationConcurrencyTrigger(slot.automationId, triggerId);
    await this.redis.zrem(totalKey, slot.runId);
    await this.redis.zrem(triggerKey, slot.runId);
  }

  /**
   * Live count of active (non-zombie) runs in a scope. Prunes stale members
   * first, so this never reports phantom runs left behind by a crash.
   * Omit `triggerId` to count the TOTAL scope.
   */
  async countActive(opts: {
    automationId: string;
    triggerId?: string;
    now?: number;
    staleMs?: number;
  }): Promise<number> {
    const now = opts.now ?? Date.now();
    const cutoff = now - (opts.staleMs ?? RunConfig.AUTOMATION_CONCURRENCY_STALE_MS);
    const key =
      opts.triggerId !== undefined
        ? RunKeys.automationConcurrencyTrigger(opts.automationId, triggerIdOf(opts))
        : RunKeys.automationConcurrencyTotal(opts.automationId);
    await this.redis.zremrangebyscore(key, '-inf', cutoff);
    return this.redis.zcard(key);
  }

  /**
   * Live run ids for a scope (zombies pruned). Omit `triggerId` for TOTAL.
   * Backs the "Active Runs" view — prunes so crashed runs never linger.
   */
  async listActiveSlots(opts: {
    automationId: string;
    triggerId?: string;
    now?: number;
    staleMs?: number;
  }): Promise<string[]> {
    const now = opts.now ?? Date.now();
    const cutoff = now - (opts.staleMs ?? RunConfig.AUTOMATION_CONCURRENCY_STALE_MS);
    const key =
      opts.triggerId !== undefined
        ? RunKeys.automationConcurrencyTrigger(opts.automationId, triggerIdOf(opts))
        : RunKeys.automationConcurrencyTotal(opts.automationId);
    await this.redis.zremrangebyscore(key, '-inf', cutoff);
    return this.redis.zrange(key, 0, -1);
  }
}

// =============================================================================
// Convenience free functions (mirror RunLock's module-level helpers)
// =============================================================================

export async function tryAcquireAutomationSlot(
  redis: Redis,
  opts: TryAcquireOptions,
): Promise<AdmissionDecision> {
  return new AutomationConcurrencyLimiter(redis).tryAcquire(opts);
}

export async function heartbeatAutomationSlot(
  redis: Redis,
  slot: AutomationConcurrencySlot,
  now?: number,
): Promise<void> {
  return new AutomationConcurrencyLimiter(redis).heartbeat(slot, now);
}

export async function releaseAutomationSlot(
  redis: Redis,
  slot: AutomationConcurrencySlot,
): Promise<void> {
  return new AutomationConcurrencyLimiter(redis).release(slot);
}
