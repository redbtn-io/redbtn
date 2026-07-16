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
 * - `interrupt` — make room by cancelling the OLDEST in-flight run(s) in the
 *                 over-cap scope, then start the new one. Cap-aware (only evicts
 *                 down to the cap) and per-scope: a per-trigger `interrupt` frees
 *                 the trigger scope, a total `interrupt` the total scope. The
 *                 limiter selects + evicts the targets atomically and returns
 *                 their runIds; performing the actual cancellation is the caller's
 *                 job. A blocking (`skip`/`queue`) cap on the OTHER scope still
 *                 wins — interrupt never bypasses it.
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
   * For an admitted `interrupt` decision: the oldest in-flight run ids that were
   * evicted (atomically, within the acquire script, respecting the scope caps) to
   * make room for this run. They are already removed from slot tracking; the
   * caller MUST cancel them. Present (possibly empty) whenever `decision` is
   * `interrupt`.
   */
  interruptRunIds?: string[];
}

// =============================================================================
// Lua — atomic acquire
// =============================================================================

/**
 * Atomic, scope-aware acquire. Prunes zombies, evaluates BOTH scopes under their
 * own overflow policy, and — in one indivisible step — either registers the run
 * (interrupting the oldest in-flight runs when a scope is `interrupt`) or blocks.
 *
 * KEYS[1] = total sorted set, KEYS[2] = per-trigger sorted set.
 * ARGV: [now, cutoff, totalMax, triggerMax, member(runId), keyTtl,
 *        totalInterrupt(0|1), triggerInterrupt(0|1)]
 *   - `totalMax` / `triggerMax`: numeric cap, or -1 for unlimited (`allow`).
 *   - `*Interrupt`: 1 when that scope's overflow mode is `interrupt` (make room by
 *     cancelling the oldest runs) rather than a hard block (`skip`/`queue`).
 *   - `cutoff`: now - staleMs. Members with score <= cutoff are dead → pruned.
 *
 * Returns [allowed(0|1), totalCount, triggerCount, blockedTrigger(0|1), interrupted]
 * where the counts are the post-decision cardinalities and `interrupted` is the
 * (possibly empty) list of runIds evicted to make room — the caller must cancel
 * them. Idempotent for an already-registered member (re-acquire just refreshes
 * its heartbeat).
 *
 * Policy: a scope at/over its cap under a blocking mode (`skip`/`queue`) is a hard
 * ceiling — an `interrupt` on the OTHER scope cannot override it, and when any
 * scope hard-blocks NOTHING is evicted (interrupt never fires just to then be
 * blocked). Only when neither scope hard-blocks do the `interrupt` scopes evict
 * their oldest members down to `cap-1`, so the new run lands exactly at the cap.
 * Interrupt targets are selected and removed INSIDE this script, closing the
 * read-then-act race that a pre-`eval` `listActiveSlots` would reopen.
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
local totalInterrupt = tonumber(ARGV[7])
local triggerInterrupt = tonumber(ARGV[8])

-- 1) prune zombies (no heartbeat within the stale window) from both scopes
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)

-- 2) idempotent re-acquire: already holding a slot → refresh + allow
if redis.call('ZSCORE', KEYS[1], member) then
  redis.call('ZADD', KEYS[1], now, member)
  redis.call('ZADD', KEYS[2], now, member)
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  return { 1, redis.call('ZCARD', KEYS[1]), redis.call('ZCARD', KEYS[2]), 0, {} }
end

local totalCount = redis.call('ZCARD', KEYS[1])
local triggerCount = redis.call('ZCARD', KEYS[2])

-- A scope hard-blocks when it is at/over its cap under a non-interrupt (skip/queue)
-- mode. \`allow\` uses cap -1 and never blocks. An interrupt scope makes room below.
local totalBlock = (totalMax >= 0) and (totalCount >= totalMax) and (totalInterrupt == 0)
local triggerBlock = (triggerMax >= 0) and (triggerCount >= triggerMax) and (triggerInterrupt == 0)

if totalBlock or triggerBlock then
  local blockedTrigger = 0
  if triggerBlock then blockedTrigger = 1 end
  return { 0, totalCount, triggerCount, blockedTrigger, {} }
end

-- No hard block. Resolve interrupt scopes by evicting the oldest runs to make room
-- (down to cap-1, so the new run lands exactly at the cap). Collect their runIds.
local interrupted = {}
local seen = {}

local function evict(fromKey, count, maxCap)
  local need = count - maxCap + 1
  if need < 1 then return end
  local victims = redis.call('ZRANGE', fromKey, 0, need - 1)
  for i = 1, #victims do
    local v = victims[i]
    if v ~= member and not seen[v] then
      redis.call('ZREM', KEYS[1], v)
      redis.call('ZREM', KEYS[2], v)
      seen[v] = true
      interrupted[#interrupted + 1] = v
    end
  end
end

-- Trigger scope first: its members are in BOTH sets, so evicting here also frees
-- total slots and keeps the two scopes consistent.
if triggerMax >= 0 and triggerInterrupt == 1 and triggerCount >= triggerMax then
  evict(KEYS[2], triggerCount, triggerMax)
  totalCount = redis.call('ZCARD', KEYS[1])
end

-- Total scope next, against the (possibly reduced) count. A total victim from
-- another trigger is removed from the total set here; its own trigger set is
-- cleaned when the caller releases the cancelled run (stale-prune backstops it).
if totalMax >= 0 and totalInterrupt == 1 and totalCount >= totalMax then
  evict(KEYS[1], totalCount, totalMax)
end

-- Register the new run in both scopes.
redis.call('ZADD', KEYS[1], now, member)
redis.call('ZADD', KEYS[2], now, member)
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)

return { 1, redis.call('ZCARD', KEYS[1]), redis.call('ZCARD', KEYS[2]), 0, interrupted }
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

    // Each scope's overflow mode is passed to the script as an interrupt flag, so
    // interrupt is handled ATOMICALLY (target selection + eviction + registration
    // in one step) and respects both caps — no separate pre-`eval` read, and a
    // per-trigger interrupt is no longer collapsed to `skip`.
    const totalInterrupt = resolved.total.mode === 'interrupt' ? 1 : 0;
    const triggerInterrupt = resolved.trigger.mode === 'interrupt' ? 1 : 0;

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
      String(totalInterrupt),
      String(triggerInterrupt),
    )) as [number, number, number, number, unknown[]];

    const allowed = Number(res[0]) === 1;
    const totalActive = Number(res[1]);
    const triggerActive = Number(res[2]);
    const interruptRunIds = (Array.isArray(res[4]) ? res[4] : [])
      .map(String)
      .filter((r) => r !== opts.runId);

    if (allowed) {
      // An interrupt scope governs this admission whenever either scope's mode is
      // `interrupt`; report the (possibly empty) list of runs the caller must cancel.
      if (totalInterrupt === 1 || triggerInterrupt === 1) {
        return { allowed: true, decision: 'interrupt', totalActive, triggerActive, interruptRunIds };
      }
      return { allowed: true, decision: 'allow', totalActive, triggerActive };
    }

    const blockedBy: 'total' | 'trigger' = Number(res[3]) === 1 ? 'trigger' : 'total';
    // The mode that governs overflow is the blocking scope's mode. A blocking scope
    // is `skip` or `queue` (`allow` never blocks; `interrupt` makes room instead).
    const mode = blockedBy === 'trigger' ? resolved.trigger.mode : resolved.total.mode;
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
