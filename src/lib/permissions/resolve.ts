/**
 * Resolve a capability profile from a graph config.
 *
 * A graph config may declare a `capabilities` profile (an agent jail). At run
 * start, `run.ts` calls `resolveCapabilityProfile(graphConfig)` and stashes the
 * result on the run control context. The native-tool dispatch chokepoint reads
 * it back via `getCapabilityProfile(state)`.
 *
 * Resolution is intentionally forgiving in ONE direction only: a missing or
 * malformed profile resolves to `null` (= unprofiled = unrestricted), which
 * preserves backward compatibility. A WELL-FORMED profile is honored exactly
 * and enforced strictly. The asymmetry is deliberate — we never want a config
 * typo to silently lock a user out of their own data, but a real profile must
 * be airtight.
 *
 * @module lib/permissions/resolve
 */

import { normalizeProfile } from './enforce';
import type { CapabilityProfile } from './types';

/**
 * The field on a graph config where the profile lives. Kept as a const so the
 * webapp/studio and any seed scripts can reference the same key.
 */
export const GRAPH_CAPABILITIES_FIELD = 'capabilities' as const;

/**
 * Read + normalize a capability profile from a graph config object.
 *
 * @param graphConfig The GraphConfig (compiledGraph.config), or any object that
 *                    may carry a `capabilities` field.
 * @returns A normalized profile, or `null` when none is declared / it's
 *          malformed (→ run is unrestricted).
 */
export function resolveCapabilityProfile(
  graphConfig: unknown,
): CapabilityProfile | null {
  if (!graphConfig || typeof graphConfig !== 'object') return null;
  const raw = (graphConfig as Record<string, unknown>)[GRAPH_CAPABILITIES_FIELD];
  if (raw === undefined || raw === null) return null;

  const profile = normalizeProfile(raw);

  // A present-but-empty `capabilities: {...}` that normalizes to zero grants is
  // a VALID lockdown profile (deny everything). But a present-but-unparseable
  // value (e.g. a string, or an object with no `capabilities` array) normalizes
  // to null — we log that, because it almost certainly indicates an authoring
  // mistake, and fall through to unrestricted (the safe-for-availability
  // choice). Operators see the warning and can fix the config.
  if (profile === null) {
    try {
      const gid = (graphConfig as Record<string, unknown>).graphId;
      console.warn(
        `[permissions] graph '${String(gid)}' declares a 'capabilities' field ` +
          `but it could not be parsed into a capability profile — treating the ` +
          `run as UNPROFILED (unrestricted). Fix the profile shape to enforce it.`,
      );
    } catch {
      /* ignore logging failure */
    }
  }

  return profile;
}
