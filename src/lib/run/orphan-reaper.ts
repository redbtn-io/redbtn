/**
 * Cross-Process Orphan Reaper
 *
 * # Why this exists
 *
 * The engine's ONLY stuck-run reaper used to be the in-process progress-idle
 * watchdog in `functions/run.ts` (`startRunProgressWatchdog`, 30 min of no
 * progress). That watchdog runs INSIDE the engine process that owns the run,
 * so when the engine container restarts (crash or redrun health-check recycle)
 * the watchdog dies with it and the run is left `status:'running'` FOREVER with
 * no live process to reap it. The durable stores (`runEvents`, `automationruns`)
 * then show phantom `running` runs indefinitely, and skip-singleton automations
 * stall behind an orphan until manually cancelled.
 *
 * This module makes orphans self-heal regardless of restarts:
 *
 *   1. STARTUP RECONCILIATION — on engine boot, one sweep marks every
 *      stale-heartbeat `running` run terminal. Cleans orphans left by the
 *      crashed engine this instance replaces AND the pre-existing backlog.
 *   2. PERIODIC SWEEP — the same sweep on a ~60s interval, independent of any
 *      single run's in-process watchdog, so an engine that dies without cleanup
 *      has its orphans reaped by a peer / successor within the fast threshold.
 *   3. SIGTERM GRACEFUL MARKING — `markInFlightRunsInterrupted` marks THIS
 *      process's own in-flight runs interrupted before exit, so a graceful
 *      redrun restart never creates orphans in the first place.
 *
 * # Correctness: never reap a live run
 *
 * A run is reaped ONLY when it is genuinely dead — no fresh heartbeat AND no
 * owning process. The two liveness signals are both engine-written and keyed by
 * runId / conversationId, so they work across processes:
 *
 *   - HEARTBEAT: the Redis run-state `run:{runId}` carries `lastProgressAt`,
 *     refreshed on every forward-progress event (see progress-heartbeat.ts). A
 *     run that is actively progressing keeps this fresh and is NEVER reaped.
 *   - OWNING PROCESS: the conversation lock `run:lock:{conversationId|runId}` is
 *     acquired before graph execution and auto-renewed every 30s (TTL 5 min, see
 *     run-lock.ts). While the owning process is alive the lock stays present;
 *     when the process dies, renewal stops and the lock expires within 5 min.
 *
 * Decision (`decideOrphan`), for a `running` doc older than the age gate:
 *   - Redis run-state MISSING            → reap (process gone; heartbeat TTL'd)
 *   - heartbeat FRESH                    → keep (actively progressing)
 *   - heartbeat STALE + lock PRESENT     → keep (live-but-idle; the 30-min
 *                                          in-process idle watchdog owns it)
 *   - heartbeat STALE + lock ABSENT      → reap (dead; no owning process)
 *
 * This is DISTINCT from the 30-min RUN_PROGRESS_STALE_MS idle timeout: a
 * live-but-idle run (long silent tool call) keeps renewing its lock, so it is
 * left to the in-process watchdog; only a run with NO owning process is reaped
 * on the fast RUN_ORPHAN_STALE_MS threshold.
 *
 * # Correctness: ownership-safe cleanup (never clobber a fresh acquirer)
 *
 * Deciding to reap and actually cleaning the run's Redis records are two steps,
 * and a replacement run can win the SAME conversation in the window between
 * them: it acquires the conversation lock (the orphan's had expired) and
 * repoints `run:conversation:{id}` at itself. A naive delete of the pointer /
 * lock at reap time would then wipe the LIVE run's records — freeing its mutex
 * so a third run could execute the conversation concurrently. So the shared,
 * conversation-scoped keys are cleaned ownership-safely:
 *
 *   - `run:conversation:{id}` stores the OWNING runId, so it is removed with an
 *     atomic compare-and-delete (Lua): delete ONLY while it still names the run
 *     being reaped. A fresh acquirer has already overwritten it with its own
 *     runId, so the CAS no-ops and its pointer survives.
 *   - `run:lock:{id}` stores a per-acquisition TOKEN, not a runId, so the reaper
 *     cannot prove ownership of it. It is NEVER blind-deleted: a reaped orphan
 *     provably holds no live lock (it is only reaped once its lock is absent, or
 *     its run-state — with a longer TTL than the lock — is already gone), so any
 *     lock present at cleanup time belongs to the fresh acquirer. The rightful
 *     owner releases its lock via RunLock (token CAS) or it TTL-expires.
 *
 * The runId-keyed scratch keys (`run:{id}`, `run:shared:{id}`,
 * `run:autostate:{id}`) are exclusively the orphan's — a fresh run has a
 * different runId — so they are cleaned unconditionally without risk.
 *
 * @module lib/run/orphan-reaper
 */
import type { Redis } from 'ioredis';
import { RunConfig, RunKeys, type RunStatus } from './types';
import { classifyRunProgressStaleness } from './progress-contract';

// ---------------------------------------------------------------------------
// Minimal Mongo surface — structurally satisfied by the mongodb driver `Db`.
// Kept tiny so the sweep is unit-testable with an in-memory fake.
// ---------------------------------------------------------------------------

export interface ReaperCursor {
  toArray(): Promise<any[]>;
}

export interface ReaperCollection {
  find(filter: Record<string, unknown>, options?: Record<string, unknown>): ReaperCursor;
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount?: number; modifiedCount?: number }>;
  createIndex?(
    keys: Record<string, number>,
    options?: Record<string, unknown>,
  ): Promise<string>;
}

export interface ReaperDb {
  collection(name: string): ReaperCollection;
}

export type ReaperDbProvider = () => Promise<ReaperDb | null>;

/** Redis surface the reaper needs. A subset of ioredis, easy to fake in tests. */
export type ReaperRedis = Pick<Redis, 'get' | 'set' | 'del' | 'exists' | 'scan' | 'eval'>;

// ---------------------------------------------------------------------------
// Durable run-status stores swept by the reaper.
//
// `runEvents`      — the leaky store whose status is never flipped on engine
//                    death (the phantom `running` pile). No lastProgressAt field.
// `automationruns` — canonical automation run records (has lastProgressAt).
// `generations`    — legacy in-progress/completed run states (kept for
//                    completeness; harmless no-op when the collection is empty).
// ---------------------------------------------------------------------------
export const ORPHAN_REAPED_COLLECTIONS = ['runEvents', 'automationruns', 'generations'] as const;
export type OrphanReapedCollection = (typeof ORPHAN_REAPED_COLLECTIONS)[number];

/** Non-terminal statuses eligible for reaping (guards every terminal write). */
const NON_TERMINAL_STATUSES = ['pending', 'queued', 'running'] as const;

const DEFAULT_CANDIDATE_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Env-configurable thresholds
// ---------------------------------------------------------------------------

function readPositiveMs(raw: unknown, fallback: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(value) && value > 0) return value;
  return fallback;
}

/**
 * FAST orphan staleness threshold (default RunConfig.RUN_ORPHAN_STALE_MS,
 * ~2.5 min). Overridable via env RUN_ORPHAN_STALE_MS. DISTINCT from the 30-min
 * RUN_PROGRESS_IDLE_TIMEOUT_MS live-but-idle window.
 */
export function getOrphanStaleThresholdMs(): number {
  return readPositiveMs(process.env.RUN_ORPHAN_STALE_MS, RunConfig.RUN_ORPHAN_STALE_MS);
}

/** Periodic sweep interval (default RunConfig.RUN_ORPHAN_SWEEP_INTERVAL_MS, 60s). */
export function getOrphanSweepIntervalMs(): number {
  return readPositiveMs(process.env.RUN_ORPHAN_SWEEP_INTERVAL_MS, RunConfig.RUN_ORPHAN_SWEEP_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Pure decision logic (no I/O — fully unit-testable)
// ---------------------------------------------------------------------------

/** Heartbeat snapshot derived from the Redis run-state key. */
export interface RunLivenessSnapshot {
  /** Whether `run:{runId}` exists in Redis. */
  stateFound: boolean;
  /** Parsed ISO heartbeat, if present and valid. */
  lastProgressAt?: string;
  /** conversationId read from the run-state (authoritative for the lock key). */
  conversationId?: string;
  /** Whether the heartbeat is older than the stale threshold (or missing). */
  isStale: boolean;
}

export interface OrphanDecision {
  reap: boolean;
  reason: string;
}

/**
 * Decide whether a `running` run is a dead orphan. Pure function of the
 * heartbeat snapshot and whether an owning-process lock is present. See the
 * module docstring for the full rationale.
 *
 * @param snapshot   Redis run-state liveness snapshot for the run.
 * @param lockPresent Whether a conversation lock for the run still exists
 *                   (proof the owning process is alive and renewing it).
 */
export function decideOrphan(snapshot: RunLivenessSnapshot, lockPresent: boolean): OrphanDecision {
  if (!snapshot.stateFound) {
    // No run-state in Redis: the owning process wrote nothing for at least the
    // 1-hour state TTL — it is gone. (A live run, even one idle far longer than
    // the fast threshold, keeps its state key refreshed until the 30-min idle
    // watchdog kills it, so it never reaches this branch.)
    return { reap: true, reason: 'engine-restart orphan — no run-state heartbeat in Redis (owning process gone)' };
  }
  if (!snapshot.isStale) {
    return { reap: false, reason: 'live — fresh progress heartbeat' };
  }
  if (lockPresent) {
    // Stale heartbeat but the owning process is still renewing its lock — this
    // is a live-but-idle run. Leave it to the 30-min in-process idle watchdog.
    return { reap: false, reason: 'live-but-idle — owning process holds the conversation lock' };
  }
  return {
    reap: true,
    reason: 'engine-restart orphan — stale progress heartbeat and no owning process (lock expired)',
  };
}

// ---------------------------------------------------------------------------
// Redis liveness reads
// ---------------------------------------------------------------------------

/**
 * Read the Redis run-state and classify heartbeat staleness. Missing state,
 * missing heartbeat, and unparsable timestamps are all stale (no proof of life).
 */
export async function readRunLiveness(
  redis: ReaperRedis,
  runId: string,
  opts: { now: Date; staleAfterMs: number },
): Promise<RunLivenessSnapshot> {
  let raw: string | null = null;
  try {
    raw = await redis.get(RunKeys.state(runId));
  } catch (err) {
    console.warn(`[orphan-reaper] Redis GET failed for ${runId} (treating as no-state):`, err);
    return { stateFound: false, isStale: true };
  }
  if (!raw) return { stateFound: false, isStale: true };

  try {
    const state = JSON.parse(raw) as { lastProgressAt?: unknown; conversationId?: unknown };
    const lastProgressAt = typeof state.lastProgressAt === 'string' ? state.lastProgressAt : undefined;
    const conversationId = typeof state.conversationId === 'string' ? state.conversationId : undefined;
    const staleness = classifyRunProgressStaleness({ lastProgressAt }, opts);
    return { stateFound: true, lastProgressAt, conversationId, isStale: staleness.isStale };
  } catch {
    // Corrupt state blob — cannot prove liveness → treat as stale.
    return { stateFound: true, isStale: true };
  }
}

/**
 * Is there a live owning-process lock for this run? Checks the base
 * `run:lock:{lockKey}` and any agent-scoped `run:lock:{lockKey}:{agentId}`
 * variants. A present lock means the owning process is alive and renewing it
 * (RunLock auto-renews every 30s). Fails SAFE: on error, reports `true`
 * (present) so we never reap on the strength of a failed lookup.
 */
export async function hasOwningLock(redis: ReaperRedis, lockKey: string): Promise<boolean> {
  try {
    const base = RunKeys.lock(lockKey);
    if ((await redis.exists(base)) > 0) return true;
    // Agent-scoped locks: run:lock:{lockKey}:{agentId}. Bounded per-conversation.
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', `${base}:*`, 'COUNT', '50');
      cursor = next;
      if (batch.length > 0) return true;
    } while (cursor !== '0');
    return false;
  } catch (err) {
    console.warn(`[orphan-reaper] lock lookup failed for ${lockKey} (assuming alive):`, err);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Ownership-safe conversation-pointer cleanup
// ---------------------------------------------------------------------------

/**
 * Compare-and-delete the conversation-run pointer: DEL `run:conversation:{id}`
 * only while it still holds `runId`. Mirrors RunLock's token-checked release so
 * the two-step "decide to reap → clean up" can never wipe a fresh acquirer's
 * pointer (it has already overwritten the key with its own runId, so the GET
 * mismatches and the DEL is skipped).
 */
const RELEASE_CONVERSATION_POINTER_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/**
 * Atomically clear the conversation-run pointer iff it still names `runId`.
 * Returns true when this run's pointer was the one removed. Fails SAFE: on a
 * Redis error it reports false (nothing removed) rather than falling back to a
 * blind delete that could clobber a live run.
 */
export async function releaseConversationPointerIfOwner(
  redis: ReaperRedis,
  conversationId: string,
  runId: string,
): Promise<boolean> {
  try {
    const res = await redis.eval(
      RELEASE_CONVERSATION_POINTER_SCRIPT,
      1,
      RunKeys.conversationRun(conversationId),
      runId,
    );
    return res === 1;
  } catch (err) {
    console.warn(
      `[orphan-reaper] conversation-pointer CAS-delete failed for ${conversationId} (run ${runId}):`,
      err,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Terminal marking
// ---------------------------------------------------------------------------

/**
 * Build the durable `$set` for a terminal reap on a given collection. `runEvents`
 * has no `error` field in its schema (mirrors the admin reconcile route); the
 * reason is recorded on `automationruns`/`generations` and in logs.
 */
export function buildTerminalSet(
  collection: string,
  status: RunStatus,
  reason: string,
  completedAt: Date,
): Record<string, unknown> {
  if (collection === 'runEvents') {
    return { status, completedAt, updatedAt: completedAt };
  }
  return { status, completedAt, error: reason };
}

export interface MarkRunTerminalOptions {
  redis: ReaperRedis;
  db: ReaperDb;
  runId: string;
  reason: string;
  /** conversationId for Redis key cleanup. Falls back to the run-state's value, then runId. */
  conversationId?: string;
  agentId?: string;
  now?: Date;
  status?: RunStatus;
  collections?: readonly string[];
}

export interface MarkRunTerminalResult {
  runId: string;
  durableModified: number;
  redisCleaned: boolean;
}

/**
 * Mark one run terminal across the durable stores AND clean its Redis run
 * records. Idempotent: the durable writes are guarded on a non-terminal status,
 * and the Redis cleanup is safe to repeat. Excludes the run from any
 * concurrency / active counting by clearing the conversation-run pointer and
 * the execution lock (freeing skip-singleton automations blocked behind it).
 */
export async function markRunTerminal(options: MarkRunTerminalOptions): Promise<MarkRunTerminalResult> {
  const now = options.now ?? new Date();
  const status = options.status ?? 'interrupted';
  const collections = options.collections ?? ORPHAN_REAPED_COLLECTIONS;
  const { redis, db, runId, reason } = options;

  // 1. Durable stores — flip non-terminal → terminal.
  let durableModified = 0;
  for (const name of collections) {
    try {
      const res = await db.collection(name).updateMany(
        { runId, status: { $in: NON_TERMINAL_STATUSES } },
        { $set: buildTerminalSet(name, status, reason, now) },
      );
      durableModified += res.modifiedCount ?? 0;
    } catch (err) {
      console.warn(`[orphan-reaper] Failed to mark ${name} terminal for ${runId}:`, err);
    }
  }

  // 2. Redis cleanup — mirror the worker reaper's cleanupStaleRunRecords so the
  //    orphan stops counting as active and its conversation lock is released.
  let redisCleaned = false;
  try {
    const stateKey = RunKeys.state(runId);
    let existing: Record<string, any> | null = null;
    try {
      const rawState = await redis.get(stateKey);
      existing = rawState ? JSON.parse(rawState) : null;
    } catch {
      existing = null;
    }

    const terminalState = {
      ...(existing ?? {}),
      runId,
      status,
      error: reason,
      completedAt: now.getTime(),
    };
    // Keep a short-lived terminal state so any late subscriber latches onto a
    // terminal event instead of hanging; it expires with the normal TTL.
    await redis.set(stateKey, JSON.stringify(terminalState), 'EX', RunConfig.STATE_TTL_SECONDS);

    const conversationId =
      options.conversationId ??
      (typeof existing?.conversationId === 'string' ? existing.conversationId : undefined);

    // runId-keyed scratch state is exclusively THIS run's (a fresh run has a
    // different runId), so it is always safe to delete unconditionally.
    const ownKeys = [...new Set([RunKeys.shared(runId), RunKeys.autoState(runId)])];
    if (ownKeys.length > 0) await redis.del(...ownKeys);

    // Conversation-scoped keys may have been taken over by a DIFFERENT, live run
    // in the window between the reaper's liveness check and here (a fresh
    // acquirer wins the lock the orphan no longer holds and repoints the
    // conversation at itself). Clean them ownership-safely:
    //   * conversationRun pointer stores the OWNING runId → compare-and-delete,
    //     so a fresh acquirer's pointer (now naming a different run) is spared.
    //   * the execution lock stores a per-acquisition TOKEN, not a runId, so we
    //     cannot prove ownership here. A reaped orphan provably holds no live
    //     lock (only reaped once its lock is absent / its run-state is gone), so
    //     any lock present now belongs to the fresh acquirer — NEVER blind-delete
    //     it. Its rightful owner releases it via RunLock (token CAS) or it
    //     TTL-expires (LOCK_TTL_SECONDS).
    if (conversationId) {
      await releaseConversationPointerIfOwner(redis, conversationId, runId);
    }
    redisCleaned = true;
  } catch (err) {
    console.warn(`[orphan-reaper] Failed to clean Redis run records for ${runId}:`, err);
  }

  return { runId, durableModified, redisCleaned };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

interface RunCandidate {
  runId: string;
  conversationId?: string;
  agentId?: string;
}

export interface ReapOrphanedRunsOptions {
  redis: ReaperRedis;
  db: ReaperDb;
  now?: Date;
  /** Stale threshold. Defaults to getOrphanStaleThresholdMs(). */
  staleAfterMs?: number;
  /** Max candidate docs per collection per sweep (backlog drains across sweeps). */
  limit?: number;
  collections?: readonly string[];
}

export interface ReapOrphanedRunsResult {
  scanned: number;
  reaped: number;
  kept: number;
  details: Array<{ runId: string; reason: string }>;
}

function collectCandidates(docs: any[], into: Map<string, RunCandidate>): void {
  for (const doc of docs) {
    const runId = typeof doc?.runId === 'string' ? doc.runId : undefined;
    if (!runId) continue;
    const existing: RunCandidate = into.get(runId) ?? { runId };
    if (!existing.conversationId) {
      if (typeof doc?.conversationId === 'string') existing.conversationId = doc.conversationId;
      else if (typeof doc?.threadId === 'string') existing.conversationId = doc.threadId;
    }
    if (!existing.agentId && typeof doc?.agentId === 'string') existing.agentId = doc.agentId;
    into.set(runId, existing);
  }
}

/** A `running` run that detection judged a dead orphan (no side effects taken). */
export interface OrphanRunInfo {
  runId: string;
  /** conversationId (run-state authoritative, else durable doc) for key cleanup / re-lock. */
  conversationId?: string;
  agentId?: string;
  /** Why it was judged an orphan (from `decideOrphan`). */
  reason: string;
}

export interface FindOrphanedRunsResult {
  scanned: number;
  orphans: OrphanRunInfo[];
  kept: number;
}

/**
 * Cross-process orphan DETECTION with no side effects. Gathers `running` runs
 * older than the age gate from the durable stores and returns those that are
 * genuinely dead — no fresh heartbeat AND no owning process — per `decideOrphan`.
 *
 * This is the SINGLE definition of "which runs are orphans": `reapOrphanedRuns`
 * (which kills them) and the worker's requeue-on-boot recovery (which
 * re-dispatches them) both consume it, so the two can never disagree.
 *
 * The age gate (startedAt older than the stale threshold) keeps a just-started
 * run — whose Redis state / lock may not have landed yet — from ever being a
 * candidate; it is a floor, not a reap condition (a live long run older than the
 * gate is still spared by its fresh heartbeat).
 */
export async function findOrphanedRuns(options: ReapOrphanedRunsOptions): Promise<FindOrphanedRunsResult> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? getOrphanStaleThresholdMs();
  const limit = options.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const collections = options.collections ?? ORPHAN_REAPED_COLLECTIONS;
  const { redis, db } = options;

  const ageCutoff = new Date(now.getTime() - staleAfterMs);
  const candidates = new Map<string, RunCandidate>();

  for (const name of collections) {
    try {
      const docs = await db
        .collection(name)
        .find(
          { status: 'running', startedAt: { $lt: ageCutoff } },
          { projection: { runId: 1, conversationId: 1, threadId: 1, agentId: 1, startedAt: 1 }, limit },
        )
        .toArray();
      collectCandidates(docs, candidates);
    } catch (err) {
      console.warn(`[orphan-reaper] Failed to scan ${name} for orphans:`, err);
    }
  }

  const orphans: OrphanRunInfo[] = [];
  let kept = 0;

  for (const candidate of candidates.values()) {
    const snapshot = await readRunLiveness(redis, candidate.runId, { now, staleAfterMs });
    // Prefer the conversationId the run-state records (authoritative for the
    // lock key); fall back to the durable doc's value.
    const conversationId = snapshot.conversationId ?? candidate.conversationId;
    const lockKey = conversationId ?? candidate.runId;

    let lockPresent = false;
    // Only the stale-but-present-state branch needs the lock check; skip the
    // Redis round-trip when state is missing (already a definitive orphan) or
    // the heartbeat is fresh (already alive).
    if (snapshot.stateFound && snapshot.isStale) {
      lockPresent = await hasOwningLock(redis, lockKey);
    }

    const decision = decideOrphan(snapshot, lockPresent);
    if (!decision.reap) {
      kept++;
      continue;
    }
    orphans.push({ runId: candidate.runId, conversationId, agentId: candidate.agentId, reason: decision.reason });
  }

  return { scanned: candidates.size, orphans, kept };
}

/**
 * Is a booting engine currently recovering (re-dispatching) this run? While a
 * recovery claim is held the reaper must NOT kill the run — a peer took
 * responsibility for requeueing it, and the re-dispatched run re-establishes a
 * fresh heartbeat. Fails SAFE: on a Redis error it reports `true` (claimed) so a
 * lookup blip never causes us to kill a run that is being recovered.
 */
export async function hasRecoveryClaim(redis: ReaperRedis, runId: string): Promise<boolean> {
  try {
    return (await redis.exists(RunKeys.recoveryClaim(runId))) > 0;
  } catch (err) {
    console.warn(`[orphan-reaper] recovery-claim lookup failed for ${runId} (assuming claimed):`, err);
    return true;
  }
}

/**
 * One cross-process sweep. Detects dead orphans via `findOrphanedRuns` and marks
 * them terminal — EXCEPT any run currently claimed for requeue-on-boot recovery,
 * which is left untouched for the recovering engine (see `hasRecoveryClaim`).
 */
export async function reapOrphanedRuns(options: ReapOrphanedRunsOptions): Promise<ReapOrphanedRunsResult> {
  const now = options.now ?? new Date();
  const collections = options.collections ?? ORPHAN_REAPED_COLLECTIONS;
  const { redis, db } = options;

  const found = await findOrphanedRuns(options);

  const details: Array<{ runId: string; reason: string }> = [];
  let reaped = 0;
  let keptForRecovery = 0;

  for (const orphan of found.orphans) {
    if (await hasRecoveryClaim(redis, orphan.runId)) {
      // A booting engine is re-dispatching this run — leave it alone.
      keptForRecovery++;
      continue;
    }
    await markRunTerminal({
      redis,
      db,
      runId: orphan.runId,
      reason: `${orphan.reason} @ ${now.toISOString()}`,
      conversationId: orphan.conversationId,
      agentId: orphan.agentId,
      now,
      collections,
    });
    reaped++;
    details.push({ runId: orphan.runId, reason: orphan.reason });
  }

  return { scanned: found.scanned, reaped, kept: found.kept + keptForRecovery, details };
}

// ---------------------------------------------------------------------------
// SIGTERM graceful marking of this process's own in-flight runs
// ---------------------------------------------------------------------------

export interface InFlightRunEntry {
  runId: string;
  conversationId?: string;
  agentId?: string;
  /**
   * The run's RunPublisher, if available. Called best-effort to publish
   * `run_interrupted` (so live SSE subscribers stop spinning) before the
   * durable stores are marked terminal.
   */
  publisher?: { interrupt(reason?: string): Promise<void> };
}

export interface MarkInFlightOptions {
  redis: ReaperRedis;
  db: ReaperDb | null;
  entries: InFlightRunEntry[];
  reason: string;
  now?: Date;
}

/**
 * Best-effort mark this engine's own in-flight runs interrupted before exit.
 * Called from `Red.shutdown()` (which the worker invokes on SIGTERM) so a
 * graceful restart does not create orphans in the first place. Each entry is
 * handled independently; a failure on one never blocks the others.
 */
export async function markInFlightRunsInterrupted(options: MarkInFlightOptions): Promise<number> {
  const { redis, db, entries, reason } = options;
  const now = options.now ?? new Date();
  let marked = 0;

  for (const entry of entries) {
    try {
      // 1. Notify live subscribers + set Redis state interrupted (publisher path).
      if (entry.publisher) {
        try {
          await entry.publisher.interrupt(reason);
        } catch (err) {
          console.warn(`[orphan-reaper] publisher.interrupt failed for ${entry.runId}:`, err);
        }
      }
      // 2. Flip the durable stores terminal (the archiver does NOT treat
      //    run_interrupted as terminal, so publisher.interrupt alone leaves
      //    runEvents `running`) and finish Redis cleanup.
      if (db) {
        await markRunTerminal({
          redis,
          db,
          runId: entry.runId,
          reason,
          conversationId: entry.conversationId,
          agentId: entry.agentId,
          now,
        });
      }
      marked++;
    } catch (err) {
      console.warn(`[orphan-reaper] Failed to mark in-flight run ${entry.runId} interrupted:`, err);
    }
  }

  return marked;
}

// ---------------------------------------------------------------------------
// Lifecycle manager — wired into Red.load() / Red.shutdown()
// ---------------------------------------------------------------------------

export interface OrphanReaperDeps {
  redis: ReaperRedis;
  /** Resolves the Mongo db handle (bundled mongoose connection). May return null pre-connect. */
  getDb: ReaperDbProvider;
  nodeId?: string;
  staleAfterMs?: number;
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/**
 * Owns the periodic sweep timer and the startup reconciliation for one engine
 * process. Instantiated in `Red.load()`; `stop()` + `markShutdownInFlight()`
 * run in `Red.shutdown()`.
 */
export class OrphanReaper {
  private readonly deps: OrphanReaperDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private indexesEnsured = false;

  constructor(deps: OrphanReaperDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private get staleAfterMs(): number {
    return this.deps.staleAfterMs ?? getOrphanStaleThresholdMs();
  }

  private get intervalMs(): number {
    return this.deps.intervalMs ?? getOrphanSweepIntervalMs();
  }

  /**
   * Best-effort create the `{status, startedAt}` indexes the sweep filters on
   * so the periodic scan is index-covered rather than a repeated COLLSCAN.
   * Idempotent — createIndex no-ops when the index already exists.
   */
  private async ensureIndexes(db: ReaperDb): Promise<void> {
    if (this.indexesEnsured) return;
    this.indexesEnsured = true;
    for (const name of ORPHAN_REAPED_COLLECTIONS) {
      try {
        const col = db.collection(name);
        if (typeof col.createIndex === 'function') {
          await col.createIndex({ status: 1, startedAt: 1 }, { background: true, name: 'orphanReaper_status_startedAt' });
        }
      } catch (err) {
        // Non-fatal: an un-indexed scan still works, just costs more.
        console.warn(`[orphan-reaper] ensureIndex on ${name} failed (non-fatal):`, err);
      }
    }
  }

  /** Run a single sweep. Guards against overlapping runs. */
  async sweep(kind: 'startup' | 'periodic'): Promise<ReapOrphanedRunsResult | null> {
    if (this.sweeping) return null;
    this.sweeping = true;
    try {
      const db = await this.deps.getDb();
      if (!db) {
        console.warn(`[orphan-reaper] ${kind} sweep skipped — Mongo not available`);
        return null;
      }
      await this.ensureIndexes(db);
      const result = await reapOrphanedRuns({
        redis: this.deps.redis,
        db,
        now: this.now(),
        staleAfterMs: this.staleAfterMs,
      });
      if (result.reaped > 0 || kind === 'startup') {
        console.log(
          `[orphan-reaper] ${kind} sweep: reaped ${result.reaped}, kept ${result.kept}, scanned ${result.scanned}` +
            (result.reaped > 0 ? ` — ${result.details.map((d) => d.runId).join(', ')}` : ''),
        );
      }
      return result;
    } catch (err) {
      console.error(`[orphan-reaper] ${kind} sweep failed:`, err);
      return null;
    } finally {
      this.sweeping = false;
    }
  }

  /** Startup reconciliation sweep. Awaited by Red.load() (fully guarded). */
  async startupReconcile(): Promise<void> {
    await this.sweep('startup');
  }

  /** Start the periodic sweep timer. Unref'd so it never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep('periodic');
    }, this.intervalMs);
    this.timer.unref?.();
    console.log(
      `[orphan-reaper] Started — interval ${Math.round(this.intervalMs / 1000)}s, ` +
        `stale threshold ${Math.round(this.staleAfterMs / 1000)}s` +
        (this.deps.nodeId ? ` (node ${this.deps.nodeId})` : ''),
    );
  }

  /** Stop the periodic sweep timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Best-effort mark the supplied in-flight runs interrupted (SIGTERM path).
   * Called from Red.shutdown() with this process's registered runs.
   */
  async markShutdownInFlight(entries: InFlightRunEntry[], reason: string): Promise<number> {
    if (entries.length === 0) return 0;
    let db: ReaperDb | null = null;
    try {
      db = await this.deps.getDb();
    } catch {
      db = null;
    }
    return markInFlightRunsInterrupted({ redis: this.deps.redis, db, entries, reason, now: this.now() });
  }
}
