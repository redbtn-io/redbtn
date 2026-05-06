/**
 * Run Shared State
 *
 * The `state.shared` namespace exposed to graph configs is backed by a
 * Redis hash at `RunKeys.shared(runId)`. It exists to give parallel
 * branches inside the same run a way to coordinate without baking
 * special-case workarounds (e.g. "thinking" flags in user-scoped global
 * state) into every graph that needs cross-branch signalling.
 *
 * Why this exists
 * ───────────────
 * LangGraph isolates state across parallel branches by design — each
 * branch gets a snapshot taken at the fan-out point and writes are only
 * merged at the join. That means a polling branch (e.g. the
 * thinking-indicator that wants to send Discord typing pings while
 * another branch is doing real work) cannot read state mutations from
 * its sibling.
 *
 * Before this module landed, configs hacked around the limitation by
 * stashing the cross-branch flag in `@redbtn/redsecrets`'s global state
 * (a per-user persistence store), polling it every 3s, and praying that
 * the producer branch wrote the terminal value before being interrupted.
 * The leaks (cross-run pollution, watchdog needed, 4.5h worst-case
 * hang) all traced back to that mismatch.
 *
 * `state.shared` fixes the layer: same Redis we already use for run
 * state, scoped to the runId, hydrated before every step + every loop
 * iteration, written through on `outputField: shared.<key>` writes.
 *
 * Read / write API
 * ────────────────
 * Configs interact with this layer through normal state syntax:
 *
 *   Reads (templates + condition evaluators):
 *     {{state.shared.thinking}}
 *
 *   Writes (transform `set` operation):
 *     { type: 'transform', config: { operation: 'set',
 *       outputField: 'shared.thinking', value: '{{true}}' } }
 *
 * The transform executor recognizes the `shared.` prefix and routes the
 * write to Redis instead of the local state object. The universal node
 * hydrates `state.shared` from Redis before each step runs (and the loop
 * executor re-hydrates between iterations) so reads always reflect what
 * peer branches have written.
 *
 * Lifecycle
 * ─────────
 * - Created lazily on first write (HSET creates the hash).
 * - TTL set to match `RunConfig.STATE_TTL_SECONDS` (1 hour) — same as
 *   run state. Refreshed on every write so an active run keeps the hash
 *   alive. Refreshed lazily on read too.
 * - Cleaned up by `RunPublisher.complete()`/`fail()`/`interrupt()` —
 *   no manual GC needed for terminal runs.
 *
 * Compared to global state (`set-global`/`get-global`)
 * ────────────────────────────────────────────────────
 * | Concern        | shared           | global state        |
 * |----------------|------------------|---------------------|
 * | Scope          | one runId        | user / automation   |
 * | Storage        | Redis hash       | Mongo collection    |
 * | Lifetime       | run's lifetime   | persistent          |
 * | Use case       | branch coord     | cross-run state     |
 *
 * Both have a place. Don't reach for global state to coordinate two
 * branches in the same run — use `state.shared`.
 */

import type Redis from 'ioredis';
import { RunKeys } from './types';
import { RunConfig } from './types';

/**
 * Read the entire shared-state hash for a run, parsing JSON values
 * back into their original types. Returns `{}` when the hash doesn't
 * exist yet (fresh run, no writes yet — totally normal).
 */
export async function readSharedState(
  redis: Redis,
  runId: string,
): Promise<Record<string, unknown>> {
  const raw = await redis.hgetall(RunKeys.shared(runId));
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = parseValue(v);
  }
  return out;
}

/**
 * Write a single `(key, value)` into the shared-state hash. Refreshes
 * TTL on every write so the hash sticks around as long as the run is
 * active. JSON-encodes value so booleans / numbers / nested objects
 * round-trip cleanly.
 */
export async function writeSharedState(
  redis: Redis,
  runId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const stored = JSON.stringify(value);
  const hashKey = RunKeys.shared(runId);
  await redis.hset(hashKey, key, stored);
  await redis.expire(hashKey, RunConfig.STATE_TTL_SECONDS);
}

/**
 * Read a single shared-state field. Returns `undefined` when missing
 * — never throws — so polling-style callers (loop exit conditions)
 * can treat absence the same as falsy without a try/catch.
 */
export async function readSharedStateField(
  redis: Redis,
  runId: string,
  key: string,
): Promise<unknown> {
  const raw = await redis.hget(RunKeys.shared(runId), key);
  return raw == null ? undefined : parseValue(raw);
}

/**
 * Delete the entire shared-state hash for a run. Called by
 * RunPublisher when the run reaches a terminal status. Cheap no-op
 * if the hash doesn't exist.
 */
export async function deleteSharedState(
  redis: Redis,
  runId: string,
): Promise<void> {
  await redis.del(RunKeys.shared(runId));
}

/**
 * Best-effort JSON parse. Falls back to the raw string for values that
 * weren't written by us (defensive — direct redis-cli pokes during
 * debugging shouldn't crash the engine).
 */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
