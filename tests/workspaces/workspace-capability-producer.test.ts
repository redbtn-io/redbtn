/**
 * The workspace producer under a capability profile (engine 0.0.296).
 *
 *   - a profiled run needs workspace:execute on the workspace to check it out,
 *     and is refused BEFORE any container is acquired;
 *   - a successful checkout DERIVES exec:execute@<checkout env> for the run, so
 *     commands work inside the checkout and nowhere else, and the grant is
 *     dropped when the step releases the checkout;
 *   - exec:execute@* (legacy) and unprofiled runs behave as before.
 *
 * acquireWorkspace and the claude-code child are mocked; no DB, no Docker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  acquired: 0,
  released: 0,
  inStep: [] as Array<{ allowed: boolean; other: boolean }>,
}));

vi.mock('../../src/lib/workspaces/WorkspaceLifecycle.js', async (orig) => {
  const m: any = await orig();
  return {
    ...m,
    acquireWorkspace: vi.fn(async () => {
      h.acquired++;
      return {
        environmentId: 'env_ws_checkout',
        acquired: {
          workspace: { workspaceId: 'ws_cap', name: 'github.com/Acme/app@beta', config: { gitRepoUrl: 'https://github.com/Acme/app.git', gitBranch: 'beta' } },
          checkout: { checkoutId: 'chk_cap', runId: 'run-cap', mode: 'branch', checkoutKey: 'card-1', branch: 'task/card-1' },
          environmentId: 'env_ws_checkout',
          nodeId: '10.100.0.5',
          containerName: 'ws_cap_chk',
          volumeName: 'ws_cap_data',
          installId: 'ws_ws_cap_chk',
          acquiredInMs: 1,
        },
        release: vi.fn(async () => {
          h.released++;
        }),
        startRenewing: vi.fn(),
        stopRenewing: vi.fn(),
      };
    }),
  };
});

vi.mock('../../src/lib/nodes/universal/executors/claudeCodeExecutor.js', async (orig) => {
  const m: any = await orig();
  return {
    ...m,
    runClaudeCodeStep: vi.fn(async (args: any) => {
      // What the CLI bridge would be allowed to do, judged mid-step.
      const { getCapabilityProfile } = await import('../../src/lib/run/contextLookup.js');
      const { enforceToolCapability } = await import('../../src/lib/permissions/enforce.js');
      const p = getCapabilityProfile(args.state);
      const tryEnv = (env: string) => {
        try {
          enforceToolCapability(p ?? null, 'run_command', { environmentId: env, command: 'ls' });
          return true;
        } catch {
          return false;
        }
      };
      h.inStep.push({ allowed: tryEnv('env_ws_checkout'), other: tryEnv('env_somewhere_else') });
      return { 'data.result': 'done' };
    }),
  };
});

import { executeNeuron } from '../../src/lib/nodes/universal/executors/neuronExecutor.js';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry.js';
import { getCapabilityProfile } from '../../src/lib/run/contextLookup.js';
import { enforceToolCapability } from '../../src/lib/permissions/enforce.js';
import { CapabilityDeniedError, type CapabilityProfile } from '../../src/lib/permissions/types.js';

const RUN = 'run-cap';

function makeState(): any {
  return {
    runId: RUN,
    userId: 'user-cap',
    neuronRegistry: {
      getConfig: vi.fn(async (id: string) => ({ id, neuronId: id, provider: 'claude-code', model: 'claude-code' })),
      getModel: vi.fn(async () => ({})),
      callNeuron: vi.fn(),
    },
    data: { workspaceId: 'ws_cap', checkoutKey: 'card-1', workspaceMode: 'branch' },
    parameters: {},
    workspaceDb: {
      collection: () => ({
        findOne: async () => ({
          workspaceId: 'ws_cap',
          name: 'github.com/Acme/app@beta',
          activeCheckouts: [],
          config: { gitRepoUrl: 'https://github.com/Acme/app.git', gitBranch: 'beta' },
        }),
      }),
    },
  };
}

const step: any = { neuronId: 'opus-5', outputField: 'data.result', userPrompt: 'do it' };

beforeEach(() => {
  h.acquired = 0;
  h.released = 0;
  h.inStep = [];
});
afterEach(() => runControlRegistry.unregister(RUN));

describe('workspace producer + derived grants', () => {
  it('workspace:execute on the workspace: checkout proceeds, exec works in the checkout only, revoked on release', async () => {
    const profile: CapabilityProfile = { name: 'op', capabilities: [{ resource: 'workspace', actions: ['execute'], selector: 'github.com/acme/app@beta' }] };
    runControlRegistry.register(RUN, 'test', { capabilityProfile: profile });
    const state = makeState();
    await executeNeuron(step, state);
    expect(h.acquired).toBe(1);
    expect(h.inStep).toEqual([{ allowed: true, other: false }]);
    expect(h.released).toBe(1);
    // released -> the derived grant is gone
    expect(() =>
      enforceToolCapability(getCapabilityProfile({ runId: RUN, data: {} }), 'run_command', { environmentId: 'env_ws_checkout' }),
    ).toThrow(CapabilityDeniedError);
  });

  it('no workspace grant: refused before any container is acquired', async () => {
    const profile: CapabilityProfile = { name: 'op', capabilities: [{ resource: 'workspace', actions: ['execute'], selector: 'ws_other' }] };
    runControlRegistry.register(RUN, 'test', { capabilityProfile: profile });
    await expect(executeNeuron(step, makeState())).rejects.toThrow(/does not allow execute on workspace/);
    expect(h.acquired).toBe(0);
    expect(h.inStep).toEqual([]);
  });

  it('read-only on the workspace is not enough to check it out', async () => {
    const profile: CapabilityProfile = { name: 'op', capabilities: [{ resource: 'workspace', actions: ['read'], selector: 'ws_cap' }] };
    runControlRegistry.register(RUN, 'test', { capabilityProfile: profile });
    await expect(executeNeuron(step, makeState())).rejects.toThrow(/workspace/);
    expect(h.acquired).toBe(0);
  });

  it('legacy exec:execute@* keeps working unchanged', async () => {
    const profile: CapabilityProfile = { name: 'redboard-red', capabilities: [{ resource: 'exec', actions: ['execute'], selector: '*' }] };
    runControlRegistry.register(RUN, 'test', { capabilityProfile: profile });
    await executeNeuron(step, makeState());
    expect(h.acquired).toBe(1);
    expect(h.inStep).toEqual([{ allowed: true, other: true }]);
  });

  it('an unprofiled run checks out as before and derives nothing (exec stays fail-closed for it)', async () => {
    runControlRegistry.register(RUN, 'test');
    await executeNeuron(step, makeState());
    expect(h.acquired).toBe(1);
    expect(h.inStep).toEqual([{ allowed: false, other: false }]);
  });
});
