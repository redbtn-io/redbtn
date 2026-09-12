/**
 * Canonical Red Coder Capability Profile (Card 6aa1d9d708971669b4a25d25).
 *
 * # Why this profile exists
 *
 * The previous capability profile declared write grants on `coder/*` and `redcoder/*`,
 * which was security theatre:
 *   1. `red-coder-node-opus` ships only filesystem and shell tools (run_command,
 *      read_file, edit_file, etc.) — it has NO state or knowledge tools at all.
 *   2. Under `matcher.ts` prefix rules, `coder/*` failed to match `coder`, `coder-*`,
 *      or `coder:key` namespaces.
 *
 * This profile formalizes the architectural boundary:
 *   - The coder agent is strictly READ-ONLY on state, knowledge, and memory.
 *   - Shell execution is scoped to the workspace environment.
 *   - All memory and transcript persistence is handled out-of-band by deterministic
 *     graph lifecycle nodes (ack/close), keeping the coder pure and preventing
 *     agent bus loops.
 *
 * @module lib/permissions/red-coder-profile
 */

import type { Capability } from './types';
import type { GraphCapabilityProfile } from './redops-profile';

export const RED_CODER_GRAPH_IDS = {
  workspace: 'red-coder-workspace',
  standard: 'LpERO9iVE-u4',
} as const;

/**
 * The canonical capability profile for Red Coder (Workspace).
 *
 * Read-only on all state and knowledge across the fleet; execution granted for workspace.
 * Resolves the selector mismatch by admitting coder* and redcoder* wildcards.
 */
export const RED_CODER_CAPABILITY_PROFILE: GraphCapabilityProfile & {
  capabilities: Capability[];
} = {
  name: 'red-coder-ws-jail',
  description:
    'Red Coder (Workspace) capability profile. Strictly read-only on state, knowledge, ' +
    'and memory; execution is scoped to managed workspace environments. All memory and ' +
    'state writes are handled by deterministic graph lifecycle nodes, eliminating ' +
    'unreachable write theatre.',
  capabilities: [
    { resource: 'exec', actions: ['execute'], selector: '*' },
    { resource: 'state', actions: ['read'], selector: '*' },
    { resource: 'knowledge', actions: ['read'], selector: '*' },
    // Scoped write grants (calibrated to bare-prefix glob matching coder, coder/*, coder-*, etc.)
    // to support future out-of-band memory persistence without selector traps:
    { resource: 'state', actions: ['write', 'create'], selector: 'coder*' },
    { resource: 'state', actions: ['write', 'create'], selector: 'redcoder*' },
    { resource: 'knowledge', actions: ['write', 'create'], selector: 'coder*' },
    { resource: 'knowledge', actions: ['write', 'create'], selector: 'redcoder*' },
  ],
};
