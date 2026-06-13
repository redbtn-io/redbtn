/**
 * Selector matching + capability decisions.
 *
 * Pure functions — no I/O, no run context. Kept separate from `enforce.ts` so
 * they're trivially unit-testable and have zero dependency on the tool layer.
 *
 * @module lib/permissions/matcher
 */

import type {
  Capability,
  CapabilityAction,
  CapabilityDecision,
  CapabilityProfile,
  CapabilityResource,
} from './types';

/**
 * Does `selector` match `address`?
 *
 * Matching rules (case-sensitive on the address; selectors are matched as
 * given). All comparisons trim surrounding whitespace first.
 *
 *   - `''`        → never matches (defensive; an empty selector grants nothing)
 *   - `'none'`    → never matches (explicit deny placeholder)
 *   - `'*'`       → matches everything
 *   - `'p/*'`     → matches `p` exactly AND any `p/...` (prefix jail incl. root)
 *   - `'p*'`      → matches anything starting with `p` (bare-prefix glob)
 *   - `'p'`       → matches `p` exactly
 *
 * NOTE: only a SINGLE trailing `*` is treated as a wildcard. Internal `*`
 * characters are matched literally — we intentionally do NOT implement a full
 * glob engine, because the security surface must stay small and predictable.
 */
export function selectorMatches(selector: string, address: string): boolean {
  const sel = (selector ?? '').trim();
  const addr = (address ?? '').trim();

  if (sel === '' || sel === 'none') return false;
  if (sel === '*') return true;

  // `p/*` — prefix jail. Matches the prefix root and anything beneath it.
  if (sel.endsWith('/*')) {
    const prefix = sel.slice(0, -2); // drop "/*"
    if (prefix === '') return false; // "/*" alone grants nothing
    return addr === prefix || addr.startsWith(prefix + '/');
  }

  // `p*` — bare-prefix glob (single trailing star). Matches by string prefix.
  if (sel.endsWith('*')) {
    const prefix = sel.slice(0, -1);
    if (prefix === '') return false; // a lone "*" was already handled above
    return addr.startsWith(prefix);
  }

  // Exact match.
  return addr === sel;
}

/** Does this single grant cover `resource` + `action` + `address`? */
function grantCovers(
  grant: Capability,
  resource: CapabilityResource,
  action: CapabilityAction,
  address: string,
): boolean {
  if (grant.resource !== resource) return false;
  if (!Array.isArray(grant.actions) || !grant.actions.includes(action)) return false;
  return selectorMatches(grant.selector, address);
}

/**
 * Decide whether a profiled run may perform `action` on `resource`/`address`.
 *
 * The profile is the UNION of its grants — allowed if ANY grant covers the
 * request. An empty / grant-less profile denies everything (fail-closed).
 *
 * This function assumes a profile IS present. The "no profile = unrestricted"
 * short-circuit lives in `enforce.ts`, NOT here, so this function stays a pure
 * decision over an explicit profile (and tests can assert lockdown directly).
 */
export function decide(
  profile: CapabilityProfile,
  resource: CapabilityResource,
  action: CapabilityAction,
  address: string,
): CapabilityDecision {
  const grants = Array.isArray(profile.capabilities) ? profile.capabilities : [];
  for (const grant of grants) {
    if (grantCovers(grant, resource, action, address)) {
      return { allowed: true, resource, action, address };
    }
  }
  return {
    allowed: false,
    resource,
    action,
    address,
    reason: buildDenialReason(profile, resource, action, address),
  };
}

/**
 * Build a concise, model-readable denial reason. Lists the selectors the
 * profile DOES grant for this resource so the model can self-correct (e.g.
 * pick a namespace inside its jail) without leaking other users' data.
 */
export function buildDenialReason(
  profile: CapabilityProfile,
  resource: CapabilityResource,
  action: CapabilityAction,
  address: string,
): string {
  const allowedSelectors = (profile.capabilities ?? [])
    .filter((c) => c.resource === resource && c.actions?.includes(action))
    .map((c) => c.selector)
    .filter((s) => s && s !== 'none');

  const scope =
    allowedSelectors.length > 0
      ? `Allowed ${resource} ${action} selectors: ${allowedSelectors.join(', ')}.`
      : `This agent has no ${resource} ${action} grants.`;

  return (
    `Permission denied: agent profile '${profile.name}' does not allow ` +
    `${action} on ${resource} address '${address}'. ${scope}`
  );
}
