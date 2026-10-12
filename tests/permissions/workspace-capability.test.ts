/**
 * `workspace` capability resource + run-scoped DERIVED grants (engine 0.0.296).
 *
 * Contract (permissions/workspace-grants.ts, docs/workspace-capabilities.md):
 *   read     workspace_get, get_workspace_task
 *   execute  workspace_for_repo, workspace_task, checkout (producer) -> derived exec on the checkout env
 *   write    workspace_ship
 *   control  workspace_merge
 * A workspace matches a selector through ANY identity (ws_ id, github.com/o/r@b, github.com/o/r, o/r, o/r@b),
 * repo forms case-insensitively. exec:execute@* is the legacy superset; unprofiled runs are fail-closed.
 * No DB, no network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { enforceToolCapability, normalizeProfile } from '../../src/lib/permissions/enforce';
import { DATA_TOOL_RULES } from '../../src/lib/permissions/tool-map';
import { CapabilityDeniedError, type CapabilityProfile } from '../../src/lib/permissions/types';
import {
  workspaceAliases,
  decideWorkspace,
  decideShipBase,
  repoBaseAliases,
  repoSlug,
  addDerivedGrant,
  revokeCheckoutGrants,
  recordWorkspaceCheckout,
  findWorkspaceCheckoutByEnv,
  recordShippedPullRequest,
  findShippedPullRequest,
} from '../../src/lib/permissions/workspace-grants';
import { resolveWorkspaceToolAddress } from '../../src/lib/permissions/workspace-address';
import { constrainProfile, selectorCovers } from '../../src/lib/permissions/constrain';
import { getCapabilityProfile, getCapabilityScopeKey, setSubgraphProfile, clearSubgraphProfile } from '../../src/lib/run/contextLookup';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import { isGuardedExecTool } from '../../src/lib/permissions/exec-guard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const WS = 'ws_0DA2G6LbYX3t';
const IDENT = { workspaceId: WS, repo: 'https://github.com/XiroEx/become.git', branch: 'beta' };
const ALIASES = workspaceAliases(IDENT);

function deniedBy(profile: CapabilityProfile | null, tool: string, args: Record<string, unknown>, extracted?: Any): CapabilityDeniedError | null {
  try {
    enforceToolCapability(profile, tool, args, extracted);
    return null;
  } catch (err) {
    if (err instanceof CapabilityDeniedError) return err;
    throw err;
  }
}

/** What redOps writes per mode for Become's workspace. */
const OP: CapabilityProfile = {
  name: 'redops-op-test',
  capabilities: [
    { resource: 'workspace', actions: ['read'], selector: WS },
    { resource: 'workspace', actions: ['execute'], selector: WS },
    { resource: 'workspace', actions: ['execute'], selector: 'github.com/XiroEx/become@beta' },
    { resource: 'workspace', actions: ['write'], selector: WS },
    { resource: 'workspace', actions: ['control'], selector: 'github.com/XiroEx/become' },
  ],
};

describe('identities', () => {
  it('a workspace answers to its id and its configured repo / repo@branch forms (canonical name included)', () => {
    expect(ALIASES).toEqual([
      WS,
      'github.com/xiroex/become@beta',
      'github.com/xiroex/become',
      'xiroex/become',
      'xiroex/become@beta',
    ]);
    expect(repoSlug('git@github.com:XiroEx/become.git')).toBe('xiroex/become');
    expect(repoSlug('https://github.com/XiroEx/become')).toBe('xiroex/become');
    expect(repoSlug('not a repo')).toBeNull();
  });
});

describe('rule table', () => {
  it('maps each workspace tool to the agreed action', () => {
    const want: Record<string, string> = {
      workspace_get: 'read',
      get_workspace_task: 'read',
      workspace_for_repo: 'execute',
      workspace_task: 'execute',
      workspace_ship: 'write',
      workspace_merge: 'control',
    };
    for (const [tool, action] of Object.entries(want)) {
      expect(DATA_TOOL_RULES[tool]?.resource, tool).toBe('workspace');
      expect(DATA_TOOL_RULES[tool]?.action, tool).toBe(action);
      expect(DATA_TOOL_RULES[tool]?.asyncResolve, tool).toBe('workspace');
    }
  });

  it('workspace tools stay under the exec runtime guard (kill switch / rate limit / audit)', () => {
    for (const t of ['workspace_for_repo', 'workspace_ship', 'workspace_merge', 'workspace_task']) {
      expect(isGuardedExecTool(t), t).toBe(true);
    }
  });

  it('normalizeProfile keeps workspace grants and the control action', () => {
    const p = normalizeProfile({ name: 'x', capabilities: [{ resource: 'workspace', actions: ['read', 'control'], selector: WS }] });
    expect(p?.capabilities).toEqual([{ resource: 'workspace', actions: ['read', 'control'], selector: WS }]);
  });
});

describe('decideWorkspace', () => {
  it('matches any identity; repo forms case-insensitively', () => {
    for (const selector of [WS, 'github.com/XiroEx/become@beta', 'XIROEX/BECOME', 'xiroex/become@beta', 'github.com/xiroex/*', 'xiroex/*', 'github.com/XiroEx/become*', '*']) {
      const p: CapabilityProfile = { name: 's', capabilities: [{ resource: 'workspace', actions: ['execute'], selector }] };
      expect(decideWorkspace(p, 'execute', ALIASES).allowed, selector).toBe(true);
    }
  });

  it('does not match another workspace, another branch or another repo', () => {
    for (const selector of ['ws_other', 'github.com/XiroEx/become@main', 'xiroex/become-native', 'github.com/other/*', 'none', '']) {
      const p: CapabilityProfile = { name: 's', capabilities: [{ resource: 'workspace', actions: ['execute'], selector }] };
      expect(decideWorkspace(p, 'execute', ALIASES).allowed, selector).toBe(false);
    }
  });

  it('actions are independent', () => {
    const p: CapabilityProfile = { name: 's', capabilities: [{ resource: 'workspace', actions: ['execute'], selector: WS }] };
    expect(decideWorkspace(p, 'read', ALIASES).allowed).toBe(false);
    expect(decideWorkspace(p, 'write', ALIASES).allowed).toBe(false);
    expect(decideWorkspace(p, 'control', ALIASES).allowed).toBe(false);
  });

  it('exec:execute@* is the legacy superset; a scoped exec grant is not', () => {
    const legacy: CapabilityProfile = { name: 'l', capabilities: [{ resource: 'exec', actions: ['execute'], selector: '*' }] };
    for (const a of ['read', 'execute', 'write', 'control'] as const) expect(decideWorkspace(legacy, a, ALIASES).allowed).toBe(true);
    const scoped: CapabilityProfile = { name: 's', capabilities: [{ resource: 'exec', actions: ['execute'], selector: 'env_1' }] };
    expect(decideWorkspace(scoped, 'execute', ALIASES).allowed).toBe(false);
  });

  it('an unidentified workspace needs a * grant, and the denial says how to grant', () => {
    expect(decideWorkspace(OP, 'execute', []).allowed).toBe(false);
    const star: CapabilityProfile = { name: 'st', capabilities: [{ resource: 'workspace', actions: ['execute'], selector: '*' }] };
    expect(decideWorkspace(star, 'execute', []).allowed).toBe(true);
    const none: CapabilityProfile = { name: 'n', capabilities: [] };
    expect(decideWorkspace(none, 'read', ALIASES).reason).toMatch(/no workspace read grants/);
  });
});

describe('decideShipBase — a PR into another base branch needs a grant naming that base', () => {
  const BECOME = { repo: 'https://github.com/XiroEx/become.git', configuredBase: 'beta' };
  const p = (selector: string, resource = 'workspace', actions = ['write']): CapabilityProfile => ({
    name: 'op',
    capabilities: [{ resource: resource as Any, actions: actions as Any, selector }],
  });

  it('into the workspace base: nothing beyond the workspace write grant', () => {
    expect(decideShipBase(p(WS), BECOME, 'beta').allowed).toBe(true);
    expect(decideShipBase(p(WS), BECOME, undefined).allowed).toBe(true);
    expect(decideShipBase(p(WS), BECOME, '').allowed).toBe(true);
  });

  it('into another base: the ws_ id and the bare repo do not reach it', () => {
    for (const sel of [WS, 'github.com/XiroEx/become', 'XiroEx/become', 'github.com/XiroEx/become@beta', 'xiroex/become@beta']) {
      const d = decideShipBase(p(sel), BECOME, 'main');
      expect(d.allowed, sel).toBe(false);
      expect(d.reason).toMatch(/only into this workspace's base branch 'beta'/);
      expect(d.reason).toMatch(/workspace:write on 'xiroex\/become@main'/);
    }
  });

  it('into another base: a write grant naming that base (either form, any case) does', () => {
    expect(decideShipBase(p('xiroex/become@main'), BECOME, 'main').allowed).toBe(true);
    expect(decideShipBase(p('github.com/XiroEx/become@main'), BECOME, 'main').allowed).toBe(true);
    // it names THAT base only
    expect(decideShipBase(p('xiroex/become@main'), BECOME, 'release').allowed).toBe(false);
    // and it must be a write grant
    expect(decideShipBase(p('xiroex/become@main', 'workspace', ['execute', 'control']), BECOME, 'main').allowed).toBe(false);
  });

  it('write@* and the legacy exec:execute@* are unchanged', () => {
    expect(decideShipBase(p('*'), BECOME, 'main').allowed).toBe(true);
    expect(decideShipBase(p('*', 'exec', ['execute']), BECOME, 'main').allowed).toBe(true);
    expect(decideShipBase(p('env_1', 'exec', ['execute']), BECOME, 'main').allowed).toBe(false);
  });

  it('a workspace without a configured base defaults to main; an unknown repo needs a * grant', () => {
    expect(decideShipBase(p(WS), { repo: 'XiroEx/become', configuredBase: undefined }, 'main').allowed).toBe(true);
    expect(decideShipBase(p('xiroex/become@x'), { repo: 'not a repo', configuredBase: 'beta' }, 'x').allowed).toBe(false);
    expect(decideShipBase(p('*'), { repo: 'not a repo', configuredBase: 'beta' }, 'x').allowed).toBe(true);
    expect(repoBaseAliases('https://github.com/XiroEx/become.git', 'Main')).toEqual(['github.com/xiroex/become@main', 'xiroex/become@main']);
    expect(repoBaseAliases('nope', 'main')).toEqual([]);
  });
});

describe('enforceToolCapability — workspace tools', () => {
  it('unprofiled runs are fail-closed (as when these were exec tools)', () => {
    for (const t of ['workspace_for_repo', 'workspace_ship', 'workspace_merge', 'workspace_get', 'workspace_task']) {
      expect(deniedBy(null, t, { repo: 'XiroEx/become', workspaceId: WS, prUrl: 'https://github.com/XiroEx/become/pull/1' })?.resource).toBe('workspace');
    }
  });

  it('workspace_for_repo (execute) matches the name form redOps grants', () => {
    expect(deniedBy(OP, 'workspace_for_repo', { repo: 'XiroEx/become', branch: 'beta' })).toBeNull();
    expect(deniedBy(OP, 'workspace_for_repo', { repo: 'XiroEx/become', branch: 'main' })?.action).toBe('execute');
    expect(deniedBy(OP, 'workspace_for_repo', { repo: 'other/repo', branch: 'beta' })).not.toBeNull();
  });

  it('workspace_merge (control) is addressed by the PR repo', () => {
    expect(deniedBy(OP, 'workspace_merge', { prUrl: 'https://github.com/XiroEx/become/pull/1887' })).toBeNull();
    expect(deniedBy(OP, 'workspace_merge', { prUrl: 'https://github.com/other/repo/pull/1' })?.action).toBe('control');
    const writeOnly: CapabilityProfile = { name: 'w', capabilities: [{ resource: 'workspace', actions: ['write'], selector: '*' }] };
    expect(deniedBy(writeOnly, 'workspace_merge', { prUrl: 'https://github.com/XiroEx/become/pull/1' })).not.toBeNull();
  });

  it('workspace_get / workspace_task are addressed by workspaceId', () => {
    expect(deniedBy(OP, 'workspace_get', { workspaceId: WS })).toBeNull();
    expect(deniedBy(OP, 'workspace_task', { workspaceId: WS, brief: 'x' })).toBeNull();
    expect(deniedBy(OP, 'workspace_get', { workspaceId: 'ws_other' })).not.toBeNull();
  });

  it('workspace_ship without a resolved checkout is unscoped: denied for scoped grants', () => {
    expect(deniedBy(OP, 'workspace_ship', { environmentId: 'env_x', branch: 'b', title: 't' })?.address).toBe('*');
    // With the dispatcher's resolution (the run's recorded checkout) it passes:
    expect(deniedBy(OP, 'workspace_ship', { environmentId: 'env_x' }, { addresses: [WS], anyOf: ALIASES })).toBeNull();
  });
});

describe('dispatch-time address resolution', () => {
  const RUN = 'run_ws_capability_test';
  afterEach(() => runControlRegistry.unregister(RUN));

  it('workspace_ship resolves to the checkout the engine recorded for the pinned env', async () => {
    runControlRegistry.register(RUN, 'w');
    recordWorkspaceCheckout(RUN, { workspaceId: WS, environmentId: 'env_a', aliases: ALIASES, repo: 'xiroex/become', baseBranch: 'beta', scopeKey: 'run' });
    const ctx: Any = { runId: RUN, state: { runId: RUN, data: { ws: { workspaceId: WS, environmentId: 'env_a' } } } };
    const r = await resolveWorkspaceToolAddress('workspace_ship', { environmentId: 'env_a', branch: 'b', title: 't' }, ctx);
    expect(r?.anyOf).toEqual(ALIASES);
    // state.data.ws naming another workspace than the env's checkout -> untrusted -> unscoped
    const forged: Any = { runId: RUN, state: { runId: RUN, data: { ws: { workspaceId: 'ws_other', environmentId: 'env_a' } } } };
    expect((await resolveWorkspaceToolAddress('workspace_ship', { environmentId: 'env_a' }, forged))?.unscoped).toBe(true);
    // an env this run never checked out -> unscoped
    expect((await resolveWorkspaceToolAddress('workspace_ship', { environmentId: 'env_b' }, ctx))?.unscoped).toBe(true);
  });

  it('workspace_merge of a PR this run shipped is addressed by the workspace only when it merges into the workspace base', async () => {
    runControlRegistry.register(RUN, 'w');
    recordShippedPullRequest(RUN, 'https://github.com/XiroEx/become/pull/10', { workspaceId: WS, aliases: ALIASES, repo: 'xiroex/become', base: 'beta', workspaceBranch: 'beta' });
    recordShippedPullRequest(RUN, 'https://github.com/XiroEx/become/pull/11', { workspaceId: WS, aliases: ALIASES, repo: 'xiroex/become', base: 'main', workspaceBranch: 'beta' });
    const ctx: Any = { runId: RUN, state: { runId: RUN, data: {} } };
    const intoBase = await resolveWorkspaceToolAddress('workspace_merge', { prUrl: 'https://github.com/XiroEx/become/pull/10' }, ctx);
    expect(intoBase?.anyOf).toContain(WS);
    expect(intoBase?.anyOf).toContain('xiroex/become@beta');
    const intoMain = await resolveWorkspaceToolAddress('workspace_merge', { prUrl: 'https://github.com/XiroEx/become/pull/11' }, ctx);
    expect(intoMain?.anyOf).not.toContain(WS);
    expect(intoMain?.anyOf).toContain('xiroex/become@main');
    const notShipped = await resolveWorkspaceToolAddress('workspace_merge', { prUrl: 'https://github.com/XiroEx/become/pull/12' }, ctx);
    expect(notShipped?.anyOf).toEqual(['github.com/xiroex/become', 'xiroex/become']);
    const idOnlyControl: CapabilityProfile = { name: 'c', capabilities: [{ resource: 'workspace', actions: ['control'], selector: WS }] };
    expect(deniedBy(idOnlyControl, 'workspace_merge', {}, intoBase!)).toBeNull();
    expect(deniedBy(idOnlyControl, 'workspace_merge', {}, intoMain!)).not.toBeNull();
    expect(deniedBy(idOnlyControl, 'workspace_merge', {}, notShipped!)).not.toBeNull();
    expect(findShippedPullRequest(RUN, 'https://github.com/xiroex/become/pull/10')?.base).toBe('beta');
  });

  it('a workspace is judged by its configured repo, never by a caller-chosen name', async () => {
    // workspace_for_repo {repo: other, name: <a granted workspace's name>} with no
    // workspace of that name yet would CREATE one for the other repo: it is judged
    // by that repo, so the name cannot borrow the grant.
    const ctx: Any = {
      runId: RUN,
      state: { runId: RUN, userId: 'user_a', data: {}, workspaceDb: { collection: () => ({ findOne: async () => null }) } },
    };
    const args = { repo: 'evil/repo', name: 'github.com/XiroEx/become@beta' };
    const r = await resolveWorkspaceToolAddress('workspace_for_repo', args, ctx);
    expect(r?.anyOf).not.toContain('github.com/xiroex/become@beta');
    expect(deniedBy(OP, 'workspace_for_repo', args, r!)?.action).toBe('execute');
    // ...and the workspace that call creates (named like Become's, configured for
    // evil/repo) cannot be checked out under Become's grants either.
    expect(decideWorkspace(OP, 'execute', workspaceAliases({ workspaceId: 'ws_evil', repo: 'evil/repo', branch: 'main' })).allowed).toBe(false);
    // An EXISTING workspace found by that name is judged by what it is.
    const existing: Any = {
      runId: RUN,
      state: {
        runId: RUN,
        userId: 'user_a',
        data: {},
        workspaceDb: { collection: () => ({ findOne: async () => ({ workspaceId: 'ws_evil', name: 'github.com/XiroEx/become@beta', config: { gitRepoUrl: 'https://github.com/evil/repo.git', gitBranch: 'main' } }) }) },
      },
    };
    const r2 = await resolveWorkspaceToolAddress('workspace_for_repo', { repo: 'XiroEx/become', branch: 'beta' }, existing);
    expect(r2?.anyOf).toEqual(['ws_evil', 'github.com/evil/repo@main', 'github.com/evil/repo', 'evil/repo', 'evil/repo@main']);
    expect(deniedBy(OP, 'workspace_for_repo', { repo: 'XiroEx/become', branch: 'beta' }, r2!)).not.toBeNull();
    // ws_ ids match exactly: a case-folded id is another workspace.
    expect(decideWorkspace(OP, 'read', workspaceAliases({ workspaceId: WS.toLowerCase() })).allowed).toBe(false);
  });

  it('non-workspace tools resolve to null (the rule extract runs)', async () => {
    expect(await resolveWorkspaceToolAddress('run_command', { environmentId: 'env_a' }, {} as Any)).toBeNull();
  });
});

describe('run-scoped derived grants', () => {
  const RUN = 'run_derived_test';
  afterEach(() => runControlRegistry.unregister(RUN));
  const base: CapabilityProfile = { name: 'op', capabilities: [{ resource: 'workspace', actions: ['execute'], selector: WS }] };

  it('are appended to the profile of their scope and revoked on release', () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: base });
    const state: Any = { runId: RUN, data: {} };
    expect(getCapabilityScopeKey(state)).toBe('run');
    expect(addDerivedGrant(RUN, 'run', { resource: 'exec', actions: ['execute'], selector: 'env_a' })).toBe(true);
    recordWorkspaceCheckout(RUN, { workspaceId: WS, environmentId: 'env_a', aliases: ALIASES, repo: 'xiroex/become', baseBranch: 'beta', scopeKey: 'run' });
    const eff = getCapabilityProfile(state);
    expect(eff.capabilities).toContainEqual({ resource: 'exec', actions: ['execute'], selector: 'env_a' });
    expect(() => enforceToolCapability(eff, 'run_command', { environmentId: 'env_a', command: 'ls' })).not.toThrow();
    expect(() => enforceToolCapability(eff, 'run_command', { environmentId: 'env_b', command: 'ls' })).toThrow(CapabilityDeniedError);
    expect(() => enforceToolCapability(eff, 'run_command', { command: 'ls' })).toThrow(CapabilityDeniedError);
    // the stored profile is never mutated
    expect(base.capabilities).toHaveLength(1);
    revokeCheckoutGrants(RUN, 'env_a');
    expect(findWorkspaceCheckoutByEnv(RUN, 'env_a')).toBeNull();
    expect(() => enforceToolCapability(getCapabilityProfile(state), 'run_command', { environmentId: 'env_a' })).toThrow(CapabilityDeniedError);
  });

  it('an unprofiled run stays unprofiled', () => {
    runControlRegistry.register(RUN, 'w');
    addDerivedGrant(RUN, 'run', { resource: 'exec', actions: ['execute'], selector: 'env_a' });
    expect(getCapabilityProfile({ runId: RUN, data: {} })).toBeUndefined();
  });

  it('a grant derived inside a trusted subgraph scope does not widen the parent run, and vice versa', () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: base });
    const sub: CapabilityProfile = { name: 'sub', capabilities: [{ resource: 'workspace', actions: ['execute'], selector: '*' }] };
    setSubgraphProfile('scope_1', sub);
    try {
      const subState: Any = { runId: RUN, data: { _capabilityScope: 'scope_1' } };
      expect(getCapabilityScopeKey(subState)).toBe('scope_1');
      addDerivedGrant(RUN, 'scope_1', { resource: 'exec', actions: ['execute'], selector: 'env_sub' });
      expect(getCapabilityProfile(subState).capabilities).toContainEqual({ resource: 'exec', actions: ['execute'], selector: 'env_sub' });
      expect(getCapabilityProfile({ runId: RUN, data: {} }).capabilities).not.toContainEqual({ resource: 'exec', actions: ['execute'], selector: 'env_sub' });
    } finally {
      clearSubgraphProfile('scope_1');
    }
  });
});

describe('constrainProfile (child-run ceiling)', () => {
  it('keeps only what the ceiling covers', () => {
    const ceiling: CapabilityProfile = { name: 'c', capabilities: [{ resource: 'workspace', actions: ['read', 'execute', 'write'], selector: '*' }] };
    const override: CapabilityProfile = {
      name: 'o',
      capabilities: [
        { resource: 'workspace', actions: ['read', 'execute', 'control'], selector: WS },
        { resource: 'exec', actions: ['execute'], selector: '*' },
        { resource: 'state', actions: ['write'], selector: '*' },
      ],
    };
    expect(constrainProfile(override, ceiling).capabilities).toEqual([
      { resource: 'workspace', actions: ['read', 'execute'], selector: WS },
    ]);
    expect(constrainProfile(override, null)).toBe(override);
  });

  it('selectorCovers', () => {
    expect(selectorCovers('*', 'x')).toBe(true);
    expect(selectorCovers('x', 'x')).toBe(true);
    expect(selectorCovers('a/*', 'a/b')).toBe(true);
    expect(selectorCovers('a/*', 'a')).toBe(true);
    expect(selectorCovers('a/*', 'ab')).toBe(false);
    expect(selectorCovers('ab*', 'abc')).toBe(true);
    expect(selectorCovers('ab*', 'abc*')).toBe(true);
    expect(selectorCovers('ab*', 'a*')).toBe(false);
    expect(selectorCovers('x', '*')).toBe(false);
    expect(selectorCovers('none', 'x')).toBe(false);
    expect(selectorCovers('GitHub.com/A/*', 'github.com/a/b', true)).toBe(true);
  });
});
