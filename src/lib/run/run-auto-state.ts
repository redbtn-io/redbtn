/**
 * Run Auto-State
 *
 * Backs the implicit cross-branch overlay for parallel-context nodes.
 * Lives at `RunKeys.autoState(runId)`, JSON-encoded, TTL-on-write.
 *
 * Why this exists (vs. `run-shared-state.ts`)
 * ───────────────────────────────────────────
 * `run-shared-state.ts` powers the EXPLICIT `state.shared.<key>`
 * namespace — authors opt in by using the prefix.
 *
 * This layer is for the IMPLICIT path: a node executing inside a
 * `parallel:` block has its `outputField` writes auto-mirrored here
 * (full path as the hash key, e.g. `data.thinking`), and the
 * universalNode pre-step hydration walks each entry and applies it
 * via setNestedProperty(state, path, value). Net effect: the same
 * node config reads/writes plain `state.data.x` with no prefix and
 * the engine handles cross-branch coordination based on the graph
 * shape — not the node's hand-written prefix.
 *
 * The two layers are kept separate for storage clarity: explicit
 * `state.shared.x` survives outside parallel blocks (e.g., for
 * cross-step persistence in a single branch), while auto-state is
 * scoped to the run and only ever written by parallel-context steps.
 */

import type Redis from 'ioredis';
import { RunKeys, RunConfig } from './types';

/**
 * Read the entire auto-state hash for a run. Each entry's key is the
 * full state path (e.g. `data.thinking`) and value is JSON-encoded.
 * Returns `{}` for runs that never entered a parallel block — single
 * empty HGETALL, cheap.
 */
export async function readAutoState(
  redis: Redis,
  runId: string,
): Promise<Record<string, unknown>> {
  const raw = await redis.hgetall(RunKeys.autoState(runId));
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = parseValue(v);
  }
  return out;
}

/**
 * Write a single (path, value) into the auto-state hash. Refreshes
 * TTL on every write so the hash sticks around as long as the run is
 * active. JSON-encodes the value so booleans / numbers / nested
 * objects round-trip cleanly.
 */
export async function writeAutoState(
  redis: Redis,
  runId: string,
  path: string,
  value: unknown,
): Promise<void> {
  const stored = JSON.stringify(value);
  const hashKey = RunKeys.autoState(runId);
  await redis.hset(hashKey, path, stored);
  await redis.expire(hashKey, RunConfig.STATE_TTL_SECONDS);
}

/**
 * Drop the auto-state hash. Called by RunPublisher when the run hits
 * a terminal status. Idempotent.
 */
export async function deleteAutoState(
  redis: Redis,
  runId: string,
): Promise<void> {
  await redis.del(RunKeys.autoState(runId));
}

/**
 * Apply every entry of an auto-state snapshot onto a local state
 * object via setNestedProperty. Mutates `state` in place. Used by
 * universalNode + loopExecutor to overlay peer-branch writes onto
 * the local snapshot before each step / iteration runs.
 */
export function applyAutoStateOnto(
  state: Record<string, unknown>,
  autoState: Record<string, unknown>,
): void {
  for (const [path, value] of Object.entries(autoState)) {
    setNestedProperty(state, path, value);
  }
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Set a value on a nested path. Mutates the input. Creates
 * intermediate objects as needed. Tolerates dotted keys ("data.thinking")
 * and nested-object keys ("data" with object value).
 */
function setNestedProperty(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (!path) return;
  const segments = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cur[seg];
    if (next === undefined || next === null || typeof next !== 'object') {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1]] = value;
}
