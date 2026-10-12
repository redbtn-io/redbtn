/**
 * workspace_ship: a pull request into a branch other than the workspace's own
 * base needs a write grant naming that base (engine 0.0.297).
 *
 * The workspace's write grant (ws_ id / bare repo) is what the dispatch gate
 * checks; it covers PRs into the workspace base only. `base: "main"` from a
 * `beta` workspace needs `workspace:write@<o>/<r>@main` (or
 * `github.com/<o>/<r>@main`), and is refused before anything is pushed.
 * No DB (fake collection), no GitHub (installation lookup mocked), no queue
 * (fake lifecycle queue).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/lib/tools/native/workspace-common', async (orig) => {
  const m: any = await orig();
  return { ...m, resolveJobInstallation: vi.fn(async () => ({ githubInstallationId: 42 })), noteShippedPullRequest: vi.fn(async () => {}) };
});

import ship from '../../src/lib/tools/native/workspace-ship';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import type { CapabilityProfile } from '../../src/lib/permissions/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const RUN = 'run_ship_base_test';
const WS_DOC = {
  workspaceId: 'ws_b',
  userId: 'user_b',
  name: 'github.com/Acme/app@beta',
  config: { gitRepoUrl: 'https://github.com/Acme/app.git', gitBranch: 'beta' },
};

function harness() {
  const calls: Any[] = [];
  const state: Any = {
    runId: RUN,
    userId: 'user_b',
    data: { userId: 'user_b', ws: { workspaceId: 'ws_b', checkoutId: 'chk_b', environmentId: 'env_b', nodeId: '10.100.0.5', mode: 'branch', checkoutKey: 'k' } },
    workspaceDb: { collection: () => ({ findOne: async () => WS_DOC, updateOne: async () => ({}) }) },
    workspaceQueue: {
      async runJob(queueName: string, jobName: string, data: Any) {
        calls.push({ queueName, jobName, data });
        return { ok: true, prUrl: 'https://github.com/Acme/app/pull/3', prNumber: 3, branch: data.branch, created: true };
      },
    },
  };
  const ctx: Any = { state, runId: RUN, publisher: null, nodeId: 'n', toolId: 't', abortSignal: null };
  return { ctx, calls };
}

const parse = (r: Any) => JSON.parse(r.content[0].text);
const writeOn = (...selectors: string[]): CapabilityProfile => ({
  name: 'op',
  capabilities: selectors.map((selector) => ({ resource: 'workspace', actions: ['write'], selector })) as Any,
});

afterEach(() => runControlRegistry.unregister(RUN));

describe('workspace_ship PR base', () => {
  it('into the workspace base (default or explicit): ships under the workspace grant', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: writeOn('ws_b') });
    for (const args of [{}, { base: 'beta' }]) {
      const { ctx, calls } = harness();
      const out = parse(await ship.handler({ branch: 'task/x', title: 't', ...args }, ctx));
      expect(out.prUrl).toBe('https://github.com/Acme/app/pull/3');
      expect(calls[0].data.base).toBe('beta');
    }
  });

  it('into another base with only the workspace grant: FORBIDDEN, nothing pushed', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: writeOn('ws_b', 'github.com/Acme/app') });
    const { ctx, calls } = harness();
    const out = parse(await ship.handler({ branch: 'task/x', title: 't', base: 'main' }, ctx));
    expect(out.code).toBe('FORBIDDEN');
    expect(out.error).toMatch(/workspace:write on 'acme\/app@main'/);
    expect(calls).toHaveLength(0);
  });

  it('into another base with a grant naming it: ships into that base', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: writeOn('ws_b', 'acme/app@main') });
    const { ctx, calls } = harness();
    const out = parse(await ship.handler({ branch: 'task/x', title: 't', base: 'main' }, ctx));
    expect(out.prUrl).toBeDefined();
    expect(calls[0].data.base).toBe('main');
  });

  it('legacy exec:execute@* ships into any base; an invalid base is rejected', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: { name: 'l', capabilities: [{ resource: 'exec', actions: ['execute'], selector: '*' }] } });
    const { ctx, calls } = harness();
    expect(parse(await ship.handler({ branch: 'task/x', title: 't', base: 'main' }, ctx)).prUrl).toBeDefined();
    expect(calls[0].data.base).toBe('main');
    expect(parse(await ship.handler({ branch: 'task/x', title: 't', base: 'bad base' }, ctx)).code).toBe('VALIDATION');
  });
});
