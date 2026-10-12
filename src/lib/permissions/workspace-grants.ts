/**
 * Workspace capabilities — the `workspace` resource and run-scoped DERIVED grants.
 *
 * A managed workspace is one GitHub repository at one base branch
 * (`ws_0DA2G6LbYX3t` = `github.com/XiroEx/become@beta`). Before this module the
 * workspace tools were mapped to `exec` with no usable address
 * (`workspace_for_repo` / `workspace_merge` unscoped, `workspace_ship` keyed by
 * a checkout environment that only exists mid-run), so nothing narrower than
 * `exec:execute@*` could ever grant "this workspace only".
 *
 * CONTRACT (docs/workspace-capabilities.md is the long form):
 *
 *   resource `workspace`, actions (redOps modes View < Work < Ship < Merge):
 *     - read     workspace_get, get_workspace_task
 *     - execute  workspace_for_repo, workspace_task, and checking the workspace
 *                out (the neuron-step producer) — which DERIVES exec on the
 *                checkout's environment until the checkout is released
 *     - write    workspace_ship (push the checkout's branch, open a PR)
 *     - control  workspace_merge (merge into the base branch)
 *
 *   A workspace answers to several identities, all derived from its id and
 *   its CONFIGURED repo + base branch (never its free-form name); a grant
 *   matches when its selector matches ANY of them (repo forms
 *   case-insensitively, ws_ ids exactly):
 *     ws_<id> · github.com/<o>/<r>@<base> · github.com/<o>/<r> · <o>/<r> · <o>/<r>@<base>
 *   Selector syntax is the usual one (exact, `p*`, `p/*`, `*`, `none`).
 *
 *   DERIVED grants: when a run whose profile allows `workspace:execute` on a
 *   workspace obtains a checkout of it, the engine adds
 *   `exec:execute@<that checkout's environmentId>` to the profile scope that
 *   earned it, for the rest of the run, so file / command tools work inside
 *   the checkout and nowhere else (exec stays fail-closed for every other env).
 *   Only checkouts the engine acquired itself or verified in Mongo derive —
 *   never an environmentId that run state merely claims.
 *
 *   Backward compatibility: a profile holding `exec:execute@*` passes every
 *   workspace action on every workspace (it could already do all of this), and
 *   unprofiled runs are unchanged (`workspace` is fail-closed like exec was).
 *
 * Run-scoped state lives on the run's RunControlContext, so it is per worker
 * process, cleared when the run unregisters, and re-derived when a retried
 * step re-binds to the run's checkout.
 *
 * @module lib/permissions/workspace-grants
 */

import { runControlRegistry } from '../run/RunControlRegistry';
import { selectorMatches } from './matcher';
import type { Capability, CapabilityAction, CapabilityDecision, CapabilityProfile } from './types';

/**
 * What identifies a workspace: its id and its CONFIGURED repository / base
 * branch. The workspace NAME is deliberately not an identity: it is a
 * caller-chosen label (`workspace_for_repo {name}`), so a run could otherwise
 * create a workspace for any repository NAMED like one it holds a grant on.
 * The canonical name `github.com/<o>/<r>@<base>` is still matched, because it
 * is derived from the configured repo and branch.
 */
export interface WorkspaceIdentity {
  workspaceId?: string | null;
  /** `owner/repo`, a github.com URL, or a git remote. */
  repo?: string | null;
  /** The workspace's BASE branch (config.gitBranch), not a checkout's task branch. */
  branch?: string | null;
}

/** Scope key of the run-level profile (a trusted subgraph's scope uses its scopeId). */
export const RUN_SCOPE = 'run';

/**
 * `owner/repo` (lower-cased) from `owner/repo`, a github.com URL or a git
 * remote; null when the input is not a GitHub repository.
 */
export function repoSlug(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const m =
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw) ||
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/.exec(raw) ||
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
  if (!m) return null;
  const [, owner, repo] = m;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return `${owner}/${repo}`.toLowerCase();
}

/** `owner/repo` (lower-cased) of a pull request URL, or null. */
export function repoSlugFromPullRequestUrl(prUrl: unknown): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+/.exec(String(prUrl ?? '').trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** Canonical form of a pull request URL (`https://github.com/<o>/<r>/pull/<n>`), or null. */
export function normalizePullRequestUrl(prUrl: unknown): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/.exec(String(prUrl ?? '').trim());
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`.toLowerCase() : null;
}

/**
 * Every identity a workspace answers to, de-duplicated. `ws_` ids keep their
 * case; repo forms are lower-cased (GitHub is case-insensitive).
 */
export function workspaceAliases(id: WorkspaceIdentity): string[] {
  const out: string[] = [];
  const push = (v: string | null | undefined) => {
    if (v && !out.includes(v)) out.push(v);
  };
  const workspaceId = typeof id.workspaceId === 'string' ? id.workspaceId.trim() : '';
  push(workspaceId || null);
  const slug = repoSlug(id.repo);
  const branch = typeof id.branch === 'string' ? id.branch.trim() : '';
  if (slug) {
    if (branch) push(`github.com/${slug}@${branch.toLowerCase()}`);
    push(`github.com/${slug}`);
    push(slug);
    if (branch) push(`${slug}@${branch.toLowerCase()}`);
  }
  return out;
}

/** Whether a workspace selector matches one identity (repo forms case-insensitively, `ws_` ids exactly). */
export function workspaceSelectorMatches(selector: string, alias: string): boolean {
  if (selectorMatches(selector, alias)) return true;
  if (String(alias ?? '').startsWith('ws_')) return false;
  return selectorMatches(String(selector ?? '').toLowerCase(), String(alias ?? '').toLowerCase());
}

/** A profile that holds `exec:execute@*` — the legacy superset of every workspace action. */
export function hasLegacyExecWildcard(profile: CapabilityProfile | null | undefined): boolean {
  return (profile?.capabilities ?? []).some(
    (c) => c.resource === 'exec' && Array.isArray(c.actions) && c.actions.includes('execute') && (c.selector ?? '').trim() === '*',
  );
}

/**
 * Decide `workspace:<action>` for one workspace (given as its identities).
 * Assumes a profile IS present — the unprofiled (fail-closed) case is the
 * caller's (enforce.ts / the producer).
 */
export function decideWorkspace(
  profile: CapabilityProfile,
  action: CapabilityAction,
  aliases: string[],
): CapabilityDecision {
  const display = aliases[0] ?? '*';
  if (hasLegacyExecWildcard(profile)) {
    return { allowed: true, resource: 'workspace', action, address: display };
  }
  const grants = (profile.capabilities ?? []).filter(
    (c) => c.resource === 'workspace' && Array.isArray(c.actions) && c.actions.includes(action),
  );
  if (aliases.length === 0) {
    // Nothing identifies the workspace: only a true wildcard may proceed.
    if (grants.some((g) => (g.selector ?? '').trim() === '*')) {
      return { allowed: true, resource: 'workspace', action, address: '*' };
    }
  } else if (grants.some((g) => aliases.some((a) => workspaceSelectorMatches(g.selector, a)))) {
    return { allowed: true, resource: 'workspace', action, address: display };
  }
  const selectors = grants.map((g) => g.selector).filter((s) => s && s !== 'none');
  const scope =
    selectors.length > 0
      ? `Allowed workspace ${action} selectors: ${selectors.join(', ')}.`
      : `This agent has no workspace ${action} grants. To allow it, add ` +
        `{"resource":"workspace","actions":["${action}"],"selector":"<owner/repo[@branch] or ws_id>"} ` +
        `to the graph's capabilities profile.`;
  return {
    allowed: false,
    resource: 'workspace',
    action,
    address: display,
    reason:
      `Permission denied: agent profile '${profile.name}' does not allow ${action} on workspace ` +
      `${aliases.length ? `'${aliases.join("' / '")}'` : '(unidentified)'}. ${scope}`,
  };
}

// ── Run-scoped state ─────────────────────────────────────────────────────────

/** A checkout this run holds (or held), as the engine itself acquired or verified it. */
export interface WorkspaceCheckoutRef {
  workspaceId: string;
  environmentId: string;
  checkoutId?: string;
  /** The workspace's identities (see workspaceAliases). */
  aliases: string[];
  /** `owner/repo`, lower-cased, when the workspace has a GitHub repo. */
  repo: string | null;
  /** The workspace's base branch. */
  baseBranch: string | null;
  /** Profile scope that earned the derived grant. */
  scopeKey: string;
}

/** A pull request this run shipped from one of its checkouts. */
export interface ShippedPullRequestRef {
  workspaceId: string;
  aliases: string[];
  repo: string | null;
  /** The base branch the PR targets. */
  base: string | null;
  /** The shipping workspace's own base branch. */
  workspaceBranch: string | null;
}

interface RunWorkspaceGrants {
  derived: Map<string, Capability[]>;
  checkouts: WorkspaceCheckoutRef[];
  shipped: Map<string, ShippedPullRequestRef>;
}

function runState(runId: string | null | undefined, create: boolean): RunWorkspaceGrants | null {
  if (!runId) return null;
  const ctx = runControlRegistry.get(runId) as (ReturnType<typeof runControlRegistry.get> & { workspaceGrants?: RunWorkspaceGrants }) | undefined;
  if (!ctx) return null;
  if (!ctx.workspaceGrants && create) {
    ctx.workspaceGrants = { derived: new Map(), checkouts: [], shipped: new Map() };
  }
  return ctx.workspaceGrants ?? null;
}

/** Grants derived for `scopeKey` during this run (empty when none). */
export function derivedGrantsFor(runId: string | null | undefined, scopeKey: string): Capability[] {
  return runState(runId, false)?.derived.get(scopeKey) ?? [];
}

/**
 * Add a derived grant to a run's profile scope. Idempotent per
 * (resource, selector, action). Returns false when the run is not registered
 * in this process (nothing to attach to).
 */
export function addDerivedGrant(runId: string | null | undefined, scopeKey: string, grant: Capability): boolean {
  const st = runState(runId, true);
  if (!st) return false;
  const list = st.derived.get(scopeKey) ?? [];
  const same = list.find((g) => g.resource === grant.resource && g.selector === grant.selector);
  if (same) {
    for (const a of grant.actions) if (!same.actions.includes(a)) same.actions.push(a);
  } else {
    list.push({ resource: grant.resource, actions: [...grant.actions], selector: grant.selector });
  }
  st.derived.set(scopeKey, list);
  return true;
}

/** Record a checkout the engine acquired or verified for this run. */
export function recordWorkspaceCheckout(runId: string | null | undefined, ref: WorkspaceCheckoutRef): void {
  const st = runState(runId, true);
  if (!st) return;
  st.checkouts = st.checkouts.filter((c) => c.environmentId !== ref.environmentId);
  st.checkouts.push(ref);
}

/** The run's checkout running in `environmentId`, if the engine recorded one. */
export function findWorkspaceCheckoutByEnv(
  runId: string | null | undefined,
  environmentId: string | null | undefined,
): WorkspaceCheckoutRef | null {
  if (!environmentId) return null;
  return runState(runId, false)?.checkouts.find((c) => c.environmentId === environmentId) ?? null;
}

/**
 * The checkout in `environmentId` was released: drop its derived exec grant
 * (from every scope) and forget it, so the run keeps no exec authority over an
 * environment it no longer holds.
 */
export function revokeCheckoutGrants(runId: string | null | undefined, environmentId: string | null | undefined): void {
  if (!environmentId) return;
  const st = runState(runId, false);
  if (!st) return;
  for (const [scope, list] of st.derived) {
    st.derived.set(
      scope,
      list.filter((g) => !(g.resource === 'exec' && g.selector === environmentId)),
    );
  }
  st.checkouts = st.checkouts.filter((c) => c.environmentId !== environmentId);
}

/** Remember that this run shipped `prUrl` from one of its checkouts. */
export function recordShippedPullRequest(
  runId: string | null | undefined,
  prUrl: string | null | undefined,
  ref: ShippedPullRequestRef,
): void {
  const key = normalizePullRequestUrl(prUrl);
  if (!key) return;
  runState(runId, true)?.shipped.set(key, ref);
}

/** The ship record for `prUrl` in this run, if any. */
export function findShippedPullRequest(
  runId: string | null | undefined,
  prUrl: string | null | undefined,
): ShippedPullRequestRef | null {
  const key = normalizePullRequestUrl(prUrl);
  if (!key) return null;
  return runState(runId, false)?.shipped.get(key) ?? null;
}

/**
 * Append the derived grants of `scopeKey` to a profile (a NEW object; the
 * stored profile is never mutated). An unprofiled run stays unprofiled.
 */
export function withDerivedGrants<T extends { capabilities?: Capability[] } | null | undefined>(
  profile: T,
  runId: string | null | undefined,
  scopeKey: string,
): T {
  if (!profile || !Array.isArray(profile.capabilities)) return profile;
  const derived = derivedGrantsFor(runId, scopeKey);
  if (derived.length === 0) return profile;
  return { ...profile, capabilities: [...profile.capabilities, ...derived] } as T;
}
