/**
 * workspace_task / invoke_graph / get_workspace_task called from the NEURON
 * TOOL-USE LOOP (engine 0.0.298).
 *
 * The neuron loop (`tool-resolver.ts` resolveNative) and the CLI run bridge
 * call native tools with `publisher: null` — on purpose, they own the tool
 * events. Both child-run tools built their engine context from
 * `context.publisher.redis`, so a model calling them always got
 * `UNAVAILABLE` / `parent_state_incomplete` (found live by the redOps agent:
 * Op op_ygba4dl4, run run_LF54JKVmV3K8oy4d3D-ev). They now fall back to the
 * RUN's own publisher from the run-control registry; a context with no
 * publisher at all still fails cleanly.
 *
 * Calls go through `resolveTools(...).invoke()` — the exact path the loop
 * uses, capability gate and exec guard included. run() and Mongo are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  runCalls: [] as Array<{ red: any; input: any; options: any }>,
  graphDoc: null as Record<string, unknown> | null,
}));

vi.mock('../../src/functions/run', async (orig) => {
  const m: any = await orig();
  return {
    ...m,
    run: vi.fn(async (red: any, input: any, options: any) => {
      h.runCalls.push({ red, input, options });
      return { runId: options.runId, status: 'completed' };
    }),
  };
});

// invoke_graph's access check reads the graphs collection through mongoose.
vi.mock('mongoose', async (orig) => {
  const m: any = await orig();
  const db = {
    collection: (name: string) => ({
      findOne: async () => (name === 'graphs' ? h.graphDoc : null),
    }),
  };
  const mongoose = { ...m.default, connection: { db, readyState: 1 } };
  return { ...m, default: mongoose, connection: mongoose.connection };
});

import { resolveTools } from '../../src/lib/tools/tool-resolver';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import workspaceTaskTool from '../../src/lib/tools/native/workspace-task';
import getWorkspaceTaskTool from '../../src/lib/tools/native/get-workspace-task';
import invokeGraphTool from '../../src/lib/tools/native/invoke-graph';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import { __setRedisForTest } from '../../src/lib/permissions/exec-guard';
import type { CapabilityProfile } from '../../src/lib/permissions/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const RUN = 'run_neuron_loop_parent_1';
const OWNER = 'user_owner_1';
const WS_DOC = {
  workspaceId: 'ws_1',
  userId: OWNER,
  name: 'github.com/Acme/app@beta',
  config: { gitRepoUrl: 'https://github.com/Acme/app.git', gitBranch: 'beta' },
  activeCheckouts: [],
};
const WORK: CapabilityProfile = { name: 'op', capabilities: [{ resource: 'workspace', actions: ['read', 'execute'], selector: 'ws_1' }] };

/** What the run publisher's Redis holds (run states keyed `run:<id>`). */
const runStates = new Map<string, unknown>();
const runRedis = { get: vi.fn(async (k: string) => (runStates.has(k) ? JSON.stringify(runStates.get(k)) : null)) };
const runPublisher = { redis: runRedis, redlog: { log: vi.fn() }, user: OWNER };

function loopState(): Any {
  return {
    runId: RUN,
    userId: OWNER,
    data: { runId: RUN },
    _graphRegistry: { getConfig: vi.fn(async (id: string) => ({ graphId: id })) },
    neuronRegistry: {},
    memory: {},
    workspaceDb: {
      collection: () => ({
        // by id only: a task run with no checkout yet is NOT findable here,
        // so get_workspace_task must be addressed from the run's own state.
        findOne: async (q: Any) => (q?.workspaceId === 'ws_1' ? WS_DOC : null),
      }),
    },
  };
}

/** Invoke a native tool exactly like the neuron tool-use loop does. */
async function callFromLoop(tool: string, args: Record<string, unknown>, state: Any): Promise<Any> {
  const [resolved] = await resolveTools([tool as Any], state);
  const result: Any = await resolved.invoke(args, { state, runId: RUN, toolId: `t_${tool}`, abortSignal: null });
  const text = result?.content?.[0]?.text;
  return { isError: result?.isError === true, body: typeof text === 'string' ? safeJson(text) : result };
}

function safeJson(t: string): Any {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

// The built registry loads tools from compiled .js files; register the TS
// sources under their real names so the loop resolves the real handlers.
const registry = getNativeRegistry();
for (const [name, def] of [
  ['workspace_task', workspaceTaskTool],
  ['get_workspace_task', getWorkspaceTaskTool],
  ['invoke_graph', invokeGraphTool],
] as const) {
  if (!registry.get(name)) registry.register(name, def as Any);
}

const prevAudit = process.env.EXEC_AUDIT_FAIL_OPEN;
beforeEach(() => {
  h.runCalls = [];
  h.graphDoc = null;
  runStates.clear();
  // No hub in a unit test: the exec guard's durable audit and Redis are out of scope here.
  process.env.EXEC_AUDIT_FAIL_OPEN = 'true';
  __setRedisForTest(null);
});
afterEach(() => {
  runControlRegistry.unregister(RUN);
  if (prevAudit === undefined) delete process.env.EXEC_AUDIT_FAIL_OPEN;
  else process.env.EXEC_AUDIT_FAIL_OPEN = prevAudit;
});

describe('from the neuron tool-use loop (context.publisher is null)', () => {
  it('workspace_task starts its child on the RUN publisher', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: WORK, runPublisher } as Any);
    const r = await callFromLoop('workspace_task', { workspaceId: 'ws_1', brief: 'Fix the redirect' }, loopState());
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ workspaceId: 'ws_1', status: 'queued' });
    await Promise.resolve();
    expect(h.runCalls).toHaveLength(1);
    expect(h.runCalls[0].red.redis).toBe(runRedis);
    expect(h.runCalls[0].options).toMatchObject({ graphId: 'workspace-task', userId: OWNER, runId: r.body.runId });
  });

  it('invoke_graph starts its child on the RUN publisher, with the run publisher identity', async () => {
    runControlRegistry.register(RUN, 'w', { runPublisher } as Any);
    h.graphDoc = { graphId: 'child-graph', userId: OWNER };
    const r = await callFromLoop('invoke_graph', { graphId: 'child-graph', input: { message: 'hi' }, wait: false }, loopState());
    expect(r.isError).toBe(false);
    expect(typeof r.body.runId).toBe('string');
    await Promise.resolve();
    expect(h.runCalls).toHaveLength(1);
    expect(h.runCalls[0].red.redis).toBe(runRedis);
    expect(h.runCalls[0].options).toMatchObject({ graphId: 'child-graph', userId: OWNER });
  });

  it('get_workspace_task reads the task through the RUN publisher (and is addressed by it)', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: WORK, runPublisher } as Any);
    runStates.set('run:run_child_task_1', {
      graphId: 'workspace-task',
      userId: OWNER,
      input: { workspaceId: 'ws_1' },
      status: 'running',
      startedAt: Date.now() - 5_000,
      lastProgressAt: new Date().toISOString(),
      graph: { executionPath: ['task'] },
    });
    const r = await callFromLoop('get_workspace_task', { runId: 'run_child_task_1' }, loopState());
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ runId: 'run_child_task_1', workspaceId: 'ws_1', status: 'working' });
  });

  it('with no run publisher anywhere, both tools fail cleanly and start nothing', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: WORK } as Any);
    const wt = await callFromLoop('workspace_task', { workspaceId: 'ws_1', brief: 'x' }, loopState());
    expect(wt.isError).toBe(true);
    expect(wt.body).toMatchObject({ code: 'UNAVAILABLE' });
    expect(String(wt.body.error)).toMatch(/cannot start a child run from this context/);

    runControlRegistry.unregister(RUN);
    runControlRegistry.register(RUN, 'w', {} as Any);
    h.graphDoc = { graphId: 'child-graph', userId: OWNER };
    const ig = await callFromLoop('invoke_graph', { graphId: 'child-graph', input: {}, wait: false }, loopState());
    expect(ig.isError).toBe(true);
    expect(ig.body).toMatchObject({ error: 'parent_state_incomplete' });
    expect(h.runCalls).toHaveLength(0);
  });
});
