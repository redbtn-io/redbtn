/**
 * workspace_get / workspace_task / get_workspace_task (engine 0.0.296).
 *
 * run() is mocked: these tests pin what workspace_task hands the child run
 * (graph, identity, the DERIVED profile) and how get_workspace_task reports a
 * task's state. No DB, no Redis, no LLM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ runCalls: [] as any[] }));

vi.mock('../../src/functions/run', async (orig) => {
  const m: any = await orig();
  return {
    ...m,
    run: vi.fn(async (_red: any, input: any, options: any) => {
      h.runCalls.push({ input, options });
      return { runId: options.runId, status: 'completed' };
    }),
  };
});

import workspaceTask from '../../src/lib/tools/native/workspace-task';
import getWorkspaceTask from '../../src/lib/tools/native/get-workspace-task';
import workspaceGet from '../../src/lib/tools/native/workspace-get';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import { deriveWorkspaceTaskProfile, WORKSPACE_TASK_GRAPH_ID } from '../../src/lib/workspaces/workspace-task-contract';
import type { CapabilityProfile } from '../../src/lib/permissions/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const RUN = 'run_parent_op';
const OWNER = 'user_owner';
const WS_DOC = {
  workspaceId: 'ws_1',
  userId: OWNER,
  name: 'github.com/Acme/app@beta',
  config: { gitRepoUrl: 'https://github.com/Acme/app.git', gitBranch: 'beta' },
  activeCheckouts: [
    { checkoutId: 'c1', checkoutKey: 'task-1', mode: 'branch', branch: 'task/x', runId: 'run_child_1', environmentId: 'env_1', createdAt: new Date(), leaseExpiresAt: new Date(Date.now() + 600_000), pr: { url: 'https://github.com/Acme/app/pull/5' } },
    { checkoutId: 'c0', checkoutKey: 'old', mode: 'branch', branch: 'b', runId: 'run_old', environmentId: 'env_0', createdAt: new Date(), leaseExpiresAt: new Date(Date.now() - 1000) },
  ],
  checkoutHistory: [{ checkoutKey: 'task-0', branch: 'task/y', runId: 'run_child_0', acquiredAt: new Date(), releasedAt: new Date(), pr: { url: 'https://github.com/Acme/app/pull/4', mergedSha: 'abc' } }],
};

function ctx(redisState: Record<string, unknown> = {}): Any {
  const redis = { get: vi.fn(async (k: string) => (k in redisState ? JSON.stringify(redisState[k]) : null)) };
  return {
    runId: RUN,
    toolId: 't',
    publisher: { redis, user: OWNER },
    state: {
      runId: RUN,
      userId: OWNER,
      _graphRegistry: { getConfig: vi.fn(async (id: string) => ({ graphId: id })) },
      neuronRegistry: {},
      memory: {},
      data: { runId: RUN },
      workspaceDb: {
        collection: (name: string) => ({
          findOne: async (q: Any) => {
            if (name === 'agentWorkspaces' || name === 'workspaces' || !name.includes('run')) {
              if (q?.workspaceId && q.workspaceId !== WS_DOC.workspaceId) return null;
              return WS_DOC;
            }
            return null;
          },
        }),
      },
    },
  };
}

function body(res: Any): Any {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  h.runCalls = [];
});
afterEach(() => runControlRegistry.unregister(RUN));

describe('workspace_get', () => {
  it('returns config, live checkouts (expired ones dropped) and recent ships', async () => {
    const res = await workspaceGet.handler({ workspaceId: 'ws_1' }, ctx());
    expect(res.isError).toBeFalsy();
    const b = body(res);
    expect(b).toMatchObject({ workspaceId: 'ws_1', repo: 'https://github.com/Acme/app.git', baseBranch: 'beta' });
    expect(b.activeCheckouts).toHaveLength(1);
    expect(b.activeCheckouts[0]).toMatchObject({ checkoutKey: 'task-1', runId: 'run_child_1', environmentId: 'env_1', pr: { url: 'https://github.com/Acme/app/pull/5' } });
    expect(b.recentShips[0].pr).toEqual({ url: 'https://github.com/Acme/app/pull/4', mergedSha: 'abc' });
  });

  it("another user's workspace reads as not found", async () => {
    const c = ctx();
    c.state.userId = 'someone_else';
    c.publisher.user = 'someone_else';
    const res = await workspaceGet.handler({ workspaceId: 'ws_1' }, c);
    expect(res.isError).toBe(true);
    expect(body(res).code).toBe('NOT_FOUND');
  });
});

describe('workspace_task', () => {
  const work: CapabilityProfile = { name: 'op', capabilities: [{ resource: 'workspace', actions: ['read', 'execute'], selector: 'ws_1' }] };
  const ship: CapabilityProfile = { name: 'op', capabilities: [{ resource: 'workspace', actions: ['read', 'execute', 'write'], selector: 'ws_1' }] };

  it('starts a child run of the worker graph as the owner, with a derived profile, and returns at once', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: work });
    const res = await workspaceTask.handler({ workspaceId: 'ws_1', brief: 'Fix the login redirect' }, ctx());
    expect(res.isError).toBeFalsy();
    const b = body(res);
    expect(b.runId).toMatch(/^run_/);
    expect(b.checkoutKey).toMatch(/^task-/);
    expect(b).toMatchObject({ workspaceId: 'ws_1', ship: false, status: 'queued' });
    await Promise.resolve();
    expect(h.runCalls).toHaveLength(1);
    const { input, options } = h.runCalls[0];
    expect(options).toMatchObject({ userId: OWNER, graphId: WORKSPACE_TASK_GRAPH_ID, runId: b.runId, stream: false });
    expect(options.connectionIdentityUserId).toBeUndefined();
    expect(options.capabilityProfileOverride).toEqual(deriveWorkspaceTaskProfile('ws_1', false));
    expect(input).toMatchObject({ workspaceId: 'ws_1', brief: 'Fix the login redirect', ship: false, base: 'beta', checkoutKey: b.checkoutKey, parentRunId: RUN });
  });

  it('ship:true needs workspace:write — and then the child may ship (never control)', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: work });
    const denied = await workspaceTask.handler({ workspaceId: 'ws_1', brief: 'x', ship: true }, ctx());
    expect(denied.isError).toBe(true);
    expect(body(denied).code).toBe('FORBIDDEN');
    expect(h.runCalls).toHaveLength(0);

    runControlRegistry.unregister(RUN);
    runControlRegistry.register(RUN, 'w', { capabilityProfile: ship });
    const ok = await workspaceTask.handler({ workspaceId: 'ws_1', brief: 'x', ship: true, base: 'main' }, ctx());
    expect(ok.isError).toBeFalsy();
    const prof = h.runCalls[0].options.capabilityProfileOverride as CapabilityProfile;
    expect(prof.capabilities).toEqual([{ resource: 'workspace', actions: ['read', 'execute', 'write'], selector: 'ws_1' }]);
    expect(JSON.stringify(prof.capabilities)).not.toMatch(/"control"|"state"|"knowledge"|"exec"/);
    expect(h.runCalls[0].input.base).toBe('main');
  });

  it('keeps the parent run-as-caller delegation', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: work });
    const c = ctx();
    c.state.callerUserId = 'user_caller';
    c.state.data.secretsIdentity = 'owner';
    WS_DOC.userId = 'user_caller';
    try {
      const res = await workspaceTask.handler({ workspaceId: 'ws_1', brief: 'x' }, c);
      expect(res.isError).toBeFalsy();
      expect(h.runCalls[0].options).toMatchObject({ userId: OWNER, connectionIdentityUserId: 'user_caller', secretsIdentity: 'owner' });
    } finally {
      WS_DOC.userId = OWNER;
    }
  });

  it('refuses unprofiled parents, foreign workspaces and bad input', async () => {
    runControlRegistry.register(RUN, 'w');
    expect(body(await workspaceTask.handler({ workspaceId: 'ws_1', brief: 'x' }, ctx())).code).toBe('FORBIDDEN');
    runControlRegistry.unregister(RUN);
    runControlRegistry.register(RUN, 'w', { capabilityProfile: work });
    expect(body(await workspaceTask.handler({ workspaceId: 'ws_nope', brief: 'x' }, ctx())).code).toBe('NOT_FOUND');
    expect(body(await workspaceTask.handler({ workspaceId: 'ws_1', brief: '' }, ctx())).code).toBe('VALIDATION');
    expect(body(await workspaceTask.handler({ workspaceId: 'ws_1', brief: 'x', base: 'bad branch' }, ctx())).code).toBe('VALIDATION');
    expect(h.runCalls).toHaveLength(0);
  });
});

describe('get_workspace_task', () => {
  const now = Date.now();
  const mk = (over: Record<string, unknown>) => ({ graphId: WORKSPACE_TASK_GRAPH_ID, userId: OWNER, input: { workspaceId: 'ws_1' }, startedAt: now - 60_000, ...over });

  it('maps run state to a compact status', async () => {
    const states = {
      'run:run_queued1': mk({ status: 'running' }),
      'run:run_neverran': mk({ status: 'running', startedAt: now - 20 * 60_000 }),
      'run:run_working1': mk({ status: 'running', lastProgressAt: new Date(now - 30_000).toISOString(), graph: { executionPath: ['task'] } }),
      'run:run_stale01': mk({ status: 'running', lastProgressAt: new Date(now - 20 * 60_000).toISOString(), graph: { executionPath: ['task'] } }),
      'run:run_shipped1': mk({ status: 'completed', tools: [{ toolName: 'workspace_ship', result: { content: [{ type: 'text', text: '{"prUrl":"https://github.com/Acme/app/pull/9"}' }] } }], output: { content: 'Shipped the fix.' } }),
      'run:run_complete1': mk({ status: 'completed', output: { content: 'Done, nothing to ship.' } }),
      'run:run_failed01': mk({ status: 'error', error: 'boom' }),
      'run:run_interrupt1': mk({ status: 'interrupted' }),
      'run:run_foreign': { ...mk({ status: 'completed' }), userId: 'other' },
      'run:run_othergraph': { ...mk({ status: 'completed' }), graphId: 'something-else' },
    };
    const c = ctx(states);
    const status = async (runId: string) => body(await getWorkspaceTask.handler({ runId }, c));
    expect((await status('run_queued1')).status).toBe('queued');
    // killed before its first heartbeat: not "queued" forever
    expect((await status('run_neverran')).status).toBe('interrupted');
    expect((await status('run_working1')).status).toBe('working');
    expect((await status('run_stale01')).status).toBe('interrupted');
    const s = await status('run_shipped1');
    expect(s).toMatchObject({ status: 'shipped', prUrl: 'https://github.com/Acme/app/pull/9', summary: 'Shipped the fix.' });
    expect((await status('run_complete1')).status).toBe('completed');
    expect(await status('run_failed01')).toMatchObject({ status: 'failed', error: 'boom' });
    expect((await status('run_interrupt1')).status).toBe('interrupted');
    expect((await status('run_foreign')).code).toBe('NOT_FOUND');
    expect((await status('run_othergraph')).code).toBe('NOT_FOUND');
  });

  it('falls back to the PR recorded on the workspace checkout', async () => {
    const c = ctx({ 'run:run_child_1': mk({ status: 'completed' }) });
    expect(body(await getWorkspaceTask.handler({ runId: 'run_child_1' }, c))).toMatchObject({ status: 'shipped', prUrl: 'https://github.com/Acme/app/pull/5' });
  });

  it('rejects a malformed run id', async () => {
    expect(body(await getWorkspaceTask.handler({ runId: 'x; drop' }, ctx())).code).toBe('VALIDATION');
  });
});
