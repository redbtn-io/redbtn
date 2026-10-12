/**
 * Constrain one capability profile by another (a CEILING).
 *
 * Used when an engine caller hands a run a derived profile
 * (`RunOptions.capabilityProfileOverride`, e.g. `workspace_task`): the run
 * gets the override's grants, but only the parts the run's own graph-declared
 * profile also allows. A graph that declares no profile imposes no ceiling.
 *
 * @module lib/permissions/constrain
 */
import type { Capability, CapabilityProfile } from './types';

/**
 * Whether every address `inner` can match is also matched by `outer`, for the
 * selector forms the matcher supports (exact, `p*`, `p/*`, `*`, `none`).
 * Conservative: when in doubt, not covered.
 */
export function selectorCovers(outer: string, inner: string, caseInsensitive = false): boolean {
  let o = String(outer ?? '').trim();
  let i = String(inner ?? '').trim();
  if (caseInsensitive) {
    o = o.toLowerCase();
    i = i.toLowerCase();
  }
  if (!o || o === 'none' || !i || i === 'none') return false;
  if (o === '*') return true;
  if (i === '*') return false;
  if (o === i) return true;
  if (o.endsWith('/*')) {
    const p = o.slice(0, -2);
    if (!p) return false;
    // inner exact, inner `x/*` or inner `x*` under the jail
    const core = i.endsWith('/*') ? i.slice(0, -2) : i.endsWith('*') ? i.slice(0, -1) : i;
    if (i.endsWith('*') && !i.endsWith('/*')) return core.startsWith(p + '/');
    return core === p || core.startsWith(p + '/');
  }
  if (o.endsWith('*')) {
    const p = o.slice(0, -1);
    if (!p) return false;
    const core = i.endsWith('/*') ? i.slice(0, -2) : i.endsWith('*') ? i.slice(0, -1) : i;
    return core.startsWith(p);
  }
  return false;
}

/** The parts of `override` that `ceiling` also allows (all of it when there is no ceiling). */
export function constrainProfile(override: CapabilityProfile, ceiling: CapabilityProfile | null | undefined): CapabilityProfile {
  if (!ceiling) return override;
  const kept: Capability[] = [];
  for (const g of override.capabilities ?? []) {
    const actions = (g.actions ?? []).filter((a) =>
      (ceiling.capabilities ?? []).some(
        (c) =>
          c.resource === g.resource &&
          Array.isArray(c.actions) &&
          c.actions.includes(a) &&
          selectorCovers(c.selector, g.selector, g.resource === 'workspace'),
      ),
    );
    if (actions.length > 0) kept.push({ resource: g.resource, actions, selector: g.selector });
  }
  return { name: override.name, description: override.description, capabilities: kept };
}
