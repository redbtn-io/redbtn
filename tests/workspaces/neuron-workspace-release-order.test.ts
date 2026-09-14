import { describe, it, expect, vi } from 'vitest';

// Regression for the first live workspace run through a prod worker (2026-09-14):
// the CLI branches returned the child's promise WITHOUT awaiting it, so the
// try/finally that owns the workspace checkout ran `release()` two seconds after
// spawn, while the Claude Code child was still working. Its bridge run_command
// then targeted a container that had already been stopped and snapshotted.
const h = vi.hoisted(() => {
  const release = vi.fn(async (_opts?: unknown) => {});
  return {
    releaseCallsWhenChildResolved: -1,
    session: {
      environmentId: 'env_order_123',
      acquired: {
        workspace: { workspaceId: 'ws_order', config: {} },
        checkout: { checkoutId: 'chk_order', runId: 'run-order' },
        environmentId: 'env_order_123',
        nodeId: '10.100.0.5',
        containerName: 'ws_order_chk_order',
        volumeName: 'ws_order_data',
        installId: 'ws_ws_order_chk_order',
        acquiredInMs: 1,
      },
      release,
    },
  };
});

vi.mock('../../src/lib/workspaces/WorkspaceLifecycle.js', async (orig) => {
  const m: any = await orig();
  return { ...m, acquireWorkspace: vi.fn(async () => h.session) };
});

vi.mock('../../src/lib/nodes/universal/executors/claudeCodeExecutor.js', async (orig) => {
  const m: any = await orig();
  return {
    ...m,
    runClaudeCodeStep: vi.fn(async () => {
      // The child takes a while; the workspace must still be held when it finishes.
      await new Promise((r) => setTimeout(r, 120));
      h.releaseCallsWhenChildResolved = h.session.release.mock.calls.length;
      return { 'data.result': 'child done' };
    }),
  };
});

import { executeNeuron } from '../../src/lib/nodes/universal/executors/neuronExecutor.js';

describe('workspace checkout lifetime vs CLI neuron child', () => {
  it('releases the workspace only AFTER the claude-code child resolves', async () => {
    const state: any = {
      runId: 'run-order',
      userId: 'user-order',
      neuronRegistry: {
        getConfig: vi.fn(async (id: string) => ({ id, neuronId: id, provider: 'claude-code', model: 'claude-code' })),
        getModel: vi.fn(async () => ({})),
        callNeuron: vi.fn(),
      },
      data: { workspaceId: 'ws_order' },
      parameters: {},
      workspaceDb: {
        collection: () => ({
          findOne: async () => ({ workspaceId: 'ws_order', activeCheckouts: [], config: {} }),
        }),
      },
    };
    const config: any = { neuronId: 'opus-5', outputField: 'data.result', userPrompt: 'append a marker to /workspace/hello.txt' };

    await executeNeuron(config, state);

    expect(h.releaseCallsWhenChildResolved).toBe(0);
    expect(h.session.release).toHaveBeenCalledTimes(1);
  });
});
