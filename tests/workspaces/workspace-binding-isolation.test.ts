/**
 * Workspace bindings must not outlive the node that set them.
 *
 * Regression for 2026-09-15 / run_1789454028274_vweebx: a
 * `redboard-red-executor-workspace` node failed at a tool step. Its neuron step
 * had acquired a managed checkout and released it correctly in its `finally`,
 * but the node's own transform steps had left `data.workspaceId`,
 * `data.workspaceMode` and `data.checkoutKey` on the state. The engine routed
 * the run to `error_handler`, whose neuron step read those fields and checked
 * the workspace out a SECOND time — for an error-reporting neuron that had no
 * business inside a working copy. That checkout then died on a hub outage
 * ("never registered an environment") and leaked its container until it was
 * removed by hand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const release = vi.fn(async (_opts?: unknown) => {});
  const acquireWorkspace = vi.fn(async (_db: unknown, opts: any) => ({
    environmentId: 'env_bind_1',
    acquired: {
      workspace: { workspaceId: opts.workspaceId, config: {} },
      checkout: {
        checkoutId: 'chk_bind_1',
        runId: opts.runId,
        mode: opts.mode,
        checkoutKey: opts.checkoutKey,
        branch: undefined,
      },
      environmentId: 'env_bind_1',
      nodeId: '10.100.0.5',
      containerName: 'ws_bind_chk_bind_1',
      volumeName: 'ws_bind_data',
      installId: 'ws_ws_bind_chk_bind_1',
      acquiredInMs: 1,
    },
    release,
    startRenewing: vi.fn(),
    stopRenewing: vi.fn(),
  }));
  return { release, acquireWorkspace };
});

vi.mock('../../src/lib/workspaces/WorkspaceLifecycle.js', async (orig) => {
  const m: any = await orig();
  return { ...m, acquireWorkspace: h.acquireWorkspace };
});

vi.mock('../../src/lib/nodes/universal/executors/claudeCodeExecutor.js', async (orig) => {
  const m: any = await orig();
  return {
    ...m,
    runClaudeCodeStep: vi.fn(async () => ({ 'data.result': 'child done' })),
  };
});

import {
  stripWorkspaceBinding,
  snapshotWorkspaceBinding,
  restoreWorkspaceBinding,
} from '../../src/lib/workspaces/workspace-binding.js';
import {
  executeNeuron,
  acquireWorkspaceForStep,
} from '../../src/lib/nodes/universal/executors/neuronExecutor.js';
import { universalNode } from '../../src/lib/nodes/universal/universalNode.js';

/** Mongo stand-in: the workspace exists and holds no checkout for this run. */
const fakeWorkspaceDb = (workspaceId: string) => ({
  collection: () => ({
    findOne: async () => ({ workspaceId, activeCheckouts: [], config: {} }),
  }),
});

const cliNeuronRegistry = () => ({
  getConfig: vi.fn(async (id: string) => ({
    id,
    neuronId: id,
    provider: 'claude-code',
    model: 'claude-code',
  })),
  getModel: vi.fn(async () => ({})),
  callNeuron: vi.fn(),
});

beforeEach(() => {
  h.release.mockClear();
  h.acquireWorkspace.mockClear();
});

describe('stripWorkspaceBinding', () => {
  it('clears every field that could re-check-out the workspace', () => {
    const state: any = {
      data: {
        workspaceId: 'ws_is8EX3zJRoEh',
        workspaceMode: 'branch',
        checkoutKey: 'card-abc',
        checkoutId: 'chk_zdj49o23Sc',
        environmentId: 'env_from_checkout',
        workingDir: '/workspace',
        ws: { workspaceId: 'ws_is8EX3zJRoEh', environmentId: 'env_from_checkout' },
        workspaceCheckout: { workspaceId: 'ws_is8EX3zJRoEh' },
        error: 'Step 2 (tool) failed: boom',
        nextGraph: 'error_handler',
      },
    };

    const cleared = stripWorkspaceBinding(state);

    for (const key of [
      'workspaceId',
      'workspaceMode',
      'checkoutKey',
      'checkoutId',
      'ws',
      'workspaceCheckout',
      'environmentId',
      'workingDir',
    ]) {
      expect(state.data, `data.${key} should be gone`).not.toHaveProperty(key);
      expect(cleared).toHaveProperty(key, undefined);
    }
    // The failure itself is what the error handler is for — don't touch it.
    expect(state.data.error).toBe('Step 2 (tool) failed: boom');
    expect(state.data.nextGraph).toBe('error_handler');
  });

  it('keeps an environmentId the run pinned itself (no checkout produced it)', () => {
    const state: any = {
      data: {
        workspaceId: 'ws_named',
        workspaceMode: 'trunk',
        environmentId: 'env_desktop_agent',
        workingDir: '/home/george/code',
      },
    };

    const cleared = stripWorkspaceBinding(state);

    expect(state.data).not.toHaveProperty('workspaceId');
    expect(state.data).not.toHaveProperty('workspaceMode');
    expect(state.data.environmentId).toBe('env_desktop_agent');
    expect(state.data.workingDir).toBe('/home/george/code');
    expect(cleared).not.toHaveProperty('environmentId');
  });

  it('is a no-op on a state with no binding', () => {
    const data = { environmentId: 'env_desktop_agent', response: 'hi' };
    const state: any = { data };

    expect(stripWorkspaceBinding(state)).toEqual({});
    expect(state.data).toEqual(data);
    expect(stripWorkspaceBinding({})).toEqual({});
    expect(stripWorkspaceBinding(undefined)).toEqual({});
  });
});

describe('error-handler transition', () => {
  it('strips the failed node\'s workspace binding before the handler runs', async () => {
    const state: any = {
      nodeConfig: {
        graphNodeId: 'error_handler',
        steps: [
          {
            type: 'transform',
            config: { operation: 'set', outputField: 'data.handled', value: true },
          },
        ],
      },
      nodeCounter: 3,
      data: {
        // Left behind by the node that failed — its transform steps wrote these.
        workspaceId: 'ws_is8EX3zJRoEh',
        workspaceMode: 'branch',
        checkoutKey: 'card-abc',
        error: 'Step 2 (tool) failed: boom',
        nextGraph: 'error_handler',
      },
    };

    const update: any = await universalNode(state);

    // Gone from the state the handler's own steps see...
    expect(state.data).not.toHaveProperty('workspaceId');
    expect(state.data).not.toHaveProperty('workspaceMode');
    expect(state.data).not.toHaveProperty('checkoutKey');
    // ...and explicitly cleared in the returned update, which is what the
    // deep-merging `data` reducer needs to clear them for everything downstream.
    expect(update.data).toHaveProperty('workspaceId', undefined);
    expect(update.data).toHaveProperty('workspaceMode', undefined);
    expect(update.data).toHaveProperty('checkoutKey', undefined);
    expect(update.data.handled).toBe(true);
  });

  it('leaves the binding alone for an ordinary node', async () => {
    const state: any = {
      nodeConfig: {
        graphNodeId: 'exec_ws',
        steps: [
          {
            type: 'transform',
            config: { operation: 'set', outputField: 'data.handled', value: true },
          },
        ],
      },
      nodeCounter: 1,
      data: { workspaceId: 'ws_is8EX3zJRoEh', workspaceMode: 'branch' },
    };

    const update: any = await universalNode(state);

    expect(state.data.workspaceId).toBe('ws_is8EX3zJRoEh');
    expect(update.data).not.toHaveProperty('workspaceId');
  });
});

describe('a step that acquired a workspace', () => {
  it('releases it and un-writes the binding it added, keeping the configured workspaceId', async () => {
    const state: any = {
      runId: 'run-bind',
      userId: 'user-bind',
      neuronRegistry: cliNeuronRegistry(),
      // What the node's own transform step configured.
      data: { workspaceId: 'ws_bind' },
      parameters: {},
      workspaceDb: fakeWorkspaceDb('ws_bind'),
    };

    await executeNeuron(
      { neuronId: 'opus-5', outputField: 'data.result', userPrompt: 'go' } as any,
      state,
    );

    expect(h.release).toHaveBeenCalledTimes(1);
    // Everything acquisition promoted onto state is gone — those fields point at
    // a container that has just been stopped and snapshotted.
    expect(state.data).not.toHaveProperty('ws');
    expect(state.data).not.toHaveProperty('environmentId');
    expect(state.data).not.toHaveProperty('checkoutId');
    expect(state.data).not.toHaveProperty('workingDir');
    expect(state.parameters).not.toHaveProperty('environmentId');
    expect(state.parameters).not.toHaveProperty('workingDir');
    // The node's own configuration survives: the executor only strips what it wrote.
    expect(state.data.workspaceId).toBe('ws_bind');
  });

  it('still acquires for a following step that names a workspace in its own parameters', async () => {
    // The error handler ran and wiped the inherited binding...
    const state: any = { runId: 'run-own', data: { nextGraph: 'error_handler' } };
    stripWorkspaceBinding(state);

    // ...and the next node's own config names one, which universalNode installs
    // on `state.parameters` from that node's parameter definitions.
    state.parameters = { workspaceId: 'ws_own', workspaceMode: 'trunk', checkoutKey: 'card-own' };
    state.workspaceDb = fakeWorkspaceDb('ws_own');

    const session = await acquireWorkspaceForStep(state);

    expect(session).not.toBeNull();
    expect(h.acquireWorkspace).toHaveBeenCalledTimes(1);
    expect(h.acquireWorkspace.mock.calls[0][1]).toMatchObject({
      workspaceId: 'ws_own',
      runId: 'run-own',
      checkoutKey: 'card-own',
      mode: 'trunk',
    });
    expect(state.data.workspaceId).toBe('ws_own');
    expect(state.data.environmentId).toBe('env_bind_1');
  });
});

describe('snapshotWorkspaceBinding / restoreWorkspaceBinding', () => {
  it('restores pre-acquisition values instead of blindly deleting them', () => {
    const state: any = {
      data: { workspaceId: 'ws_outer', environmentId: 'env_outer', workingDir: '/srv/app' },
      parameters: { environmentId: 'env_outer' },
    };
    const before = snapshotWorkspaceBinding(state);

    // Simulate what acquireWorkspaceForStep writes.
    state.data.environmentId = 'env_inner';
    state.data.checkoutId = 'chk_inner';
    state.data.ws = { workspaceId: 'ws_outer', environmentId: 'env_inner' };
    state.data.workingDir = '/workspace';
    state.parameters.environmentId = 'env_inner';

    restoreWorkspaceBinding(state, before);

    expect(state.data.workspaceId).toBe('ws_outer');
    expect(state.data.environmentId).toBe('env_outer');
    expect(state.data.workingDir).toBe('/srv/app');
    expect(state.data).not.toHaveProperty('checkoutId');
    expect(state.data).not.toHaveProperty('ws');
    expect(state.parameters.environmentId).toBe('env_outer');
  });
});
