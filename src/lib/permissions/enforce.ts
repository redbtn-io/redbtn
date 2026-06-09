/**
 * Capability enforcement for native data tools.
 *
 * This is the fail-closed gate. It is called from the single native-tool
 * dispatch chokepoint (`NativeToolRegistry.callTool`) BEFORE a tool handler
 * runs.
 *
 * # The contract
 *
 *   - No profile on the run  → ALLOW (unrestricted, backward-compatible).
 *   - Tool not in the data-tool map → ALLOW (out of scope for this layer).
 *   - Profile present + data tool   → check every address the call targets;
 *       deny if ANY address lacks a matching grant.
 *   - Unscoped call (broad/all)     → require a wildcard-capable grant
 *       (`selector: '*'`); a prefix-only grant does NOT satisfy an unscoped
 *       op, because the op could touch resources outside the prefix.
 *
 * On denial we THROW `CapabilityDeniedError`. The caller (callTool) converts it
 * into a model-readable `isError` tool result so the LLM can adapt instead of
 * the whole run crashing.
 *
 * @module lib/permissions/enforce
 */

import { decide, selectorMatches } from './matcher';
import { getDataToolRule } from './tool-map';
import {
  CapabilityDeniedError,
  type CapabilityProfile,
} from './types';

/** Does the profile have ANY grant whose selector is a wildcard for this resource+action? */
function hasWildcardGrant(
  profile: CapabilityProfile,
  resource: string,
  action: string,
): boolean {
  return (profile.capabilities ?? []).some(
    (c) =>
      c.resource === (resource as CapabilityProfile['capabilities'][number]['resource']) &&
      c.actions?.includes(action as CapabilityProfile['capabilities'][number]['actions'][number]) &&
      // A grant whose selector matches the universal wildcard satisfies an
      // unscoped op. We test via selectorMatches against a sentinel that only
      // `'*'` can match — any address — so `'*'` qualifies but `'p/*'` does not.
      c.selector?.trim() === '*',
  );
}

/**
 * Enforce the capability profile for a native tool call.
 *
 * @param profile  The run's capability profile, or `null`/`undefined` for an
 *                 unprofiled (unrestricted) run.
 * @param toolName The native tool being invoked.
 * @param args     The tool's raw arguments (address is extracted from these).
 *
 * @throws CapabilityDeniedError when a profiled run is not permitted.
 */
export function enforceToolCapability(
  profile: CapabilityProfile | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
): void {
  // 1. No profile → today's behavior, fully unrestricted.
  if (!profile) return;

  // 2. Not a data tool → out of scope for this layer.
  const rule = getDataToolRule(toolName);
  if (!rule) return;

  const { resource, action } = rule;
  const { addresses, unscoped } = rule.extract(args ?? {});

  // 3. Unscoped/broad call (e.g. list-all, search-all with no filter, or a
  //    required-address tool called without its address). Fail-closed: require
  //    a true wildcard grant. A prefix grant must NOT silently authorize a
  //    broad op that could reach outside the prefix.
  if (unscoped || addresses.length === 0) {
    if (hasWildcardGrant(profile, resource, action)) return;
    throw new CapabilityDeniedError({
      resource,
      action,
      address: '*',
      profileName: profile.name,
      message:
        `Permission denied: agent profile '${profile.name}' does not allow an ` +
        `unscoped ${action} on ${resource}. This operation can touch resources ` +
        `outside the agent's allowed prefix and requires an explicit '*' grant. ` +
        `Narrow the request to a specific ${resource === 'state' ? 'namespace' : 'library'} ` +
        `within the agent's scope.`,
    });
  }

  // 4. Scoped call — every targeted address must have a matching grant.
  for (const address of addresses) {
    const decision = decide(profile, resource, action, address);
    if (!decision.allowed) {
      throw new CapabilityDeniedError({
        resource,
        action,
        address,
        profileName: profile.name,
        message: decision.reason ?? 'Permission denied.',
      });
    }
  }
}

/**
 * Validate + normalize a raw capability profile object (as read from a graph
 * config / Mongo document) into a typed `CapabilityProfile`, or return null if
 * it isn't a usable profile.
 *
 * Returning null for a malformed profile means the run is treated as UNPROFILED
 * (unrestricted). That is the backward-compatible default — a typo in a profile
 * must never accidentally lock a user out of their own data without an
 * operator-visible profile. Malformed-but-present profiles are logged by the
 * resolver, not here.
 */
export function normalizeProfile(raw: unknown): CapabilityProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const caps = obj.capabilities;
  if (!Array.isArray(caps)) return null;

  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : 'unnamed-profile';
  const normalized: CapabilityProfile = {
    name,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    capabilities: [],
  };

  for (const c of caps) {
    if (!c || typeof c !== 'object') continue;
    const cap = c as Record<string, unknown>;
    const resource = cap.resource;
    if (resource !== 'state' && resource !== 'knowledge') continue;
    const actions = Array.isArray(cap.actions)
      ? cap.actions.filter(
          (a): a is 'read' | 'write' | 'create' | 'delete' =>
            a === 'read' || a === 'write' || a === 'create' || a === 'delete',
        )
      : [];
    if (actions.length === 0) continue;
    const selector = typeof cap.selector === 'string' ? cap.selector : '';
    normalized.capabilities.push({ resource, actions, selector });
  }

  return normalized;
}

// Re-export for ergonomic single-import callers.
export { selectorMatches };
