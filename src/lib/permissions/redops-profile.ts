/**
 * The canonical Red Ops capability profile — typed, single source of truth.
 *
 * # Why this lives in `src/` and not only in a JSON file
 *
 * The profile is DATA (it is applied to graph documents in Mongo, not read by
 * the engine at runtime), but typing it here buys three things a loose JSON
 * file cannot:
 *
 *   1. `tsc` proves the profile is expressible as a `GraphConfig['capabilities']`
 *      value. Before this module, `resource: 'exec'` did not typecheck against
 *      the graph types at all — they only admitted `state | knowledge` — so an
 *      exec grant could not be authored in a type-checked context.
 *   2. `RED_OPS_CAPABILITY_PROFILE` is annotated with BOTH the graph-side shape
 *      and the permissions-core `Capability[]` shape. That is a bidirectional
 *      drift guard: if either union stops admitting `exec` / `execute`, THE
 *      BUILD BREAKS here rather than silently at 3am in production.
 *   3. `ops/red-ops/red-ops-capability-profile.json` is asserted equal to this
 *      const by `tests/permissions/redops-exec-profile.test.ts`, so the
 *      deployable artifact cannot drift from the reviewed source.
 *
 * # What this profile is for
 *
 * The three Red Ops graphs (see `RED_OPS_GRAPH_IDS`) declare NO capability
 * profile today. `exec` is fail-closed (`enforce.ts`), so every `ssh_shell`
 * call they make is denied and survives ONLY because `PERMISSIONS_SHADOW=true`
 * downgrades the denial to a logged shadow-block. The day shadow mode is turned
 * off, all Red Ops SSH stops fleet-wide. Attaching this profile removes that
 * dependency on shadow mode.
 *
 * Apply/verify procedure: `ops/red-ops/CAPABILITY-PROFILE-RUNBOOK.md`.
 *
 * @module lib/permissions/redops-profile
 */

import type { GraphConfig } from '../types/graph';
import type { Capability } from './types';

/** The capability-profile shape as a graph config declares it. */
export type GraphCapabilityProfile = NonNullable<GraphConfig['capabilities']>;

/** One grant inside a graph-declared capability profile. */
export type GraphCapabilityEntry = GraphCapabilityProfile['capabilities'][number];

/**
 * The three graphs that dispatch the Red Ops fleet. All three are PUBLISHED and
 * all three run the single node `red-ops-pipeline-executor`. Fork-copies inherit
 * config, so fixing these sources propagates to forks.
 */
export const RED_OPS_GRAPH_IDS = {
  coordinator: 'tHXXSTFtOuM9',
  worker: 'eCrxF8-glwgW',
  reviewer: 'red-reviewer',
} as const;

/**
 * The canonical profile to attach to each graph in `RED_OPS_GRAPH_IDS`.
 *
 * The double type annotation is deliberate — see the drift-guard note above.
 * `GraphCapabilityProfile` is the shape a graph config may declare;
 * `{ capabilities: Capability[] }` is the shape the enforcement core consumes.
 * The value must satisfy both.
 *
 * ## Why `selector: '*'` is MANDATORY for exec (not a convenience)
 *
 * `tool-map.ts:107-111` (`envId`) extracts the exec address from the call's
 * `environmentId` argument, and returns `{ addresses: [], unscoped: true }` when
 * there is none. All three `ssh_shell` steps in `red-ops-pipeline-executor`
 * (step indices 5, 9 and 12 — claim, CLI session, completion) pass inline
 * `host` / `port` / `user` / `sshKey` parameters and NO `environmentId`, so
 * every Red Ops exec call is unscoped. `enforce.ts` step 3 requires a true
 * wildcard grant for an unscoped call: a prefix or exact selector such as
 * `'alphaSystem'` is REJECTED, because an unscoped op could reach outside the
 * named scope. A per-environment selector would therefore deny 100% of Red Ops
 * SSH — the exact outage this profile exists to prevent.
 *
 * ## Why `state` and `knowledge` are granted wildcard too
 *
 * Attaching ANY profile flips state/knowledge from fail-open (unrestricted) to
 * enforced. `red-ops-pipeline-executor` calls no State or Knowledge tool today
 * — its only tool steps are the three `ssh_shell` calls, everything else is a
 * pure `transform` step, which the capability layer does not gate — so an
 * exec-only profile would work right now. It is still the wrong choice here:
 *
 *   - It would be a silent trap. The Coordinator graph carried a triage tier
 *     that read and wrote the `red-ops/*` State namespaces (see
 *     `ops/red-ops/README.md`), and re-adding any such step under an exec-only
 *     profile would fail closed with no warning at author time.
 *   - It buys no containment. `exec:execute` on `'*'` is arbitrary shell as
 *     `alpha` on the fleet host, which already subsumes every data path a State
 *     jail could protect. Restricting data while granting unrestricted shell is
 *     security theater with a real availability cost.
 *
 * So the data grants exist to make attaching this profile a pure ADDITION of
 * exec authority with zero change to data behavior. `computer:control` is
 * deliberately NOT granted: these graphs call no `desktop_*` tool, and unlike
 * state/knowledge, withholding it takes nothing away (computer is fail-closed,
 * so it is already denied today).
 */
export const RED_OPS_CAPABILITY_PROFILE: GraphCapabilityProfile & {
  capabilities: Capability[];
} = {
  name: 'red-ops-fleet-exec',
  description:
    'Red Ops fleet dispatch (Coordinator / Worker / Reviewer). Grants unscoped exec so the ' +
    "executor node's three inline ssh_shell steps run without depending on PERMISSIONS_SHADOW; " +
    "the '*' selector is required because those calls pass no environmentId (tool-map.ts:107-111) " +
    'and an unscoped exec call rejects any non-wildcard selector (enforce.ts step 3). State and ' +
    'knowledge are granted wildcard to preserve the unprofiled data behavior these graphs have ' +
    'today, since attaching any profile switches those resources from fail-open to enforced.',
  capabilities: [
    { resource: 'exec', actions: ['execute'], selector: '*' },
    { resource: 'state', actions: ['read', 'write', 'create', 'delete'], selector: '*' },
    { resource: 'knowledge', actions: ['read', 'write', 'create', 'delete'], selector: '*' },
  ],
};
