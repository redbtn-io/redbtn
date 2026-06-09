/**
 * Subgraph Tool Visibility Tests
 *
 * Proves the contract added by feat/subgraph-tool-visibility:
 *
 *  1. RunPublisher.toolStart({ subgraph }) tags the persisted `state.tools`
 *     entry (and the tool_start event) with `subgraph:{depth,graphId,name}`.
 *  2. A top-level tool (no subgraph option) has NO `subgraph` field — the
 *     existing behavior is preserved exactly.
 *  3. graphExecutor propagates the parent runId into `subInput.data.runId` /
 *     `subInput.data.options.runId` (so inner subgraph nodes resolve the
 *     parent RunPublisher) AND writes the `state.data._subgraph` tag that the
 *     tool/neuron executors forward to toolStart.
 *
 * The bug this guards against: when a `graph` step used inputMapping, the
 * subgraph's data started empty and never carried `data.runId`, so the inner
 * tool calls resolved no RunPublisher and were invisible at the parent run
 * level (observed live on run_K5bQmNvIHTxjpHNbRrfC_ / graph LpERO9iVE-u4).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunPublisher } from '../../src/lib/run/run-publisher';
import type { RunState } from '../../src/lib/run/types';
import { executeGraph } from '../../src/lib/nodes/universal/executors/graphExecutor';

// graphExecutor lazily `require`s contextLookup at call time. We stub it so
// getGraphRegistry returns the registry the tests inject via state._graphRegistry
// (its production fallback behavior anyway), without needing a real run context.
vi.mock('../../src/lib/run/contextLookup', () => ({
  getGraphRegistry: (s: any) => s?._graphRegistry,
}));

// ---------------------------------------------------------------------------
// Minimal in-memory Redis mock (self-contained).
// ---------------------------------------------------------------------------
function createMockRedis() {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();
  return {
    _store: store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string) => { const e = store.has(k); store.delete(k); return e ? 1 : 0; }),
    ttl: vi.fn(async () => -2),
    expire: vi.fn(async () => 1),
    incr: vi.fn(async (k: string) => {
      const n = Number(store.get(k) ?? '0') + 1; store.set(k, String(n)); return n;
    }),
    rpush: vi.fn(async (k: string, ...vals: string[]) => {
      if (!lists.has(k)) lists.set(k, []); lists.get(k)!.push(...vals); return lists.get(k)!.length;
    }),
    lrange: vi.fn(async () => []),
    publish: vi.fn(async () => 0),
    pipeline: vi.fn(() => {
      const ops: Array<[string, unknown[]]> = [];
      const chain: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'exec') return async () => ops.map(() => [null, 'OK']);
          return (...args: unknown[]) => { ops.push([prop, args]); return chain; };
        },
      });
      return chain;
    }),
    multi: vi.fn(function (this: any) { return this.pipeline(); }),
    quit: vi.fn(async () => 'OK'),
    duplicate: vi.fn(function (this: any) { return this; }),
  };
}

function readState(redis: ReturnType<typeof createMockRedis>): RunState {
  return JSON.parse(redis._store.get('run:run-vis-1')!) as RunState;
}

describe('Subgraph tool visibility — RunPublisher tagging', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let publisher: RunPublisher;

  beforeEach(async () => {
    redis = createMockRedis();
    // Archive side-channel off so the test doesn't try to hit BullMQ.
    process.env.ARCHIVE_QUEUE_DISABLED = 'true';
    publisher = new RunPublisher({ redis: redis as any, runId: 'run-vis-1', userId: 'user-1' });
    await publisher.init('parent-graph', 'Parent Graph', {});
  });

  it('tags a subgraph tool in state.tools with subgraph:{depth,graphId,name}', async () => {
    await publisher.toolStart('tool-sub', 'get_context_history', 'native', {
      input: {},
      subgraph: { depth: 1, graphId: 'coder-context-builder', name: 'Coder Context Builder' },
    });
    await publisher.toolComplete('tool-sub', { ok: true });

    const state = readState(redis);
    const tool = state.tools.find((t) => t.toolId === 'tool-sub')!;
    expect(tool).toBeDefined();
    expect(tool.subgraph).toEqual({
      depth: 1,
      graphId: 'coder-context-builder',
      name: 'Coder Context Builder',
    });
  });

  it('does NOT add a subgraph field to top-level tools', async () => {
    await publisher.toolStart('tool-top', 'web_search', 'mcp', { input: { q: 'x' } });
    await publisher.toolComplete('tool-top', { results: [] });

    const state = readState(redis);
    const tool = state.tools.find((t) => t.toolId === 'tool-top')!;
    expect(tool).toBeDefined();
    expect('subgraph' in tool).toBe(false);
    expect(tool.subgraph).toBeUndefined();
  });

  it('nested subgraphs carry their own depth (2+)', async () => {
    await publisher.toolStart('tool-nested', 'now', 'native', {
      input: {},
      subgraph: { depth: 2, graphId: 'inner-graph', name: 'Inner Graph' },
    });
    const state = readState(redis);
    const tool = state.tools.find((t) => t.toolId === 'tool-nested')!;
    expect(tool.subgraph?.depth).toBe(2);
    expect(tool.subgraph?.graphId).toBe('inner-graph');
  });

  it('keeps the tag through complete/error so the archived message tools stay tagged', async () => {
    // Complete one subgraph tool and error another — both must retain the tag
    // (the archiver persists state.tools verbatim onto the assistant message).
    await publisher.toolStart('tool-done', 'now', 'native', {
      input: {},
      subgraph: { depth: 1, graphId: 'g', name: 'G' },
    });
    await publisher.toolComplete('tool-done', { ts: 1 });

    await publisher.toolStart('tool-fail', 'scrape_url', 'native', {
      input: {},
      subgraph: { depth: 1, graphId: 'g', name: 'G' },
    });
    await publisher.toolError('tool-fail', 'boom');

    const state = readState(redis);
    const done = state.tools.find((t) => t.toolId === 'tool-done')!;
    const fail = state.tools.find((t) => t.toolId === 'tool-fail')!;
    expect(done.status).toBe('completed');
    expect(done.subgraph).toEqual({ depth: 1, graphId: 'g', name: 'G' });
    expect(fail.status).toBe('error');
    expect(fail.subgraph).toEqual({ depth: 1, graphId: 'g', name: 'G' });
  });
});

describe('Subgraph tool visibility — graphExecutor propagation', () => {
  it('propagates parent runId into data.runId/options.runId and writes the _subgraph tag', async () => {
    let captured: any;
    const fakeRegistry = {
      getGraph: vi.fn(async () => ({
        graph: {
          invoke: vi.fn(async (input: any) => {
            captured = input;
            return { data: { result: 'ok' } };
          }),
        },
      })),
      getConfig: vi.fn(async () => ({ graphId: 'sub-graph', name: 'Sub Graph' })),
    };

    // Parent state — runId at top level + data.runId (mirrors run.ts seed).
    const parentState = {
      runId: 'parent-run-1',
      userId: 'user-1',
      _graphRegistry: fakeRegistry,
      data: {
        runId: 'parent-run-1',
        userId: 'user-1',
        options: { runId: 'parent-run-1', graphId: 'parent-graph' },
        query: { message: 'hi' },
      },
    };

    await executeGraph(
      { graphId: 'sub-graph', outputField: 'data.subResult', inputMapping: { q: '{{state.data.query.message}}' } },
      parentState,
    );

    expect(captured).toBeDefined();
    // runId reached the subgraph via data (the only declared channel).
    expect(captured.data.runId).toBe('parent-run-1');
    expect(captured.data.options.runId).toBe('parent-run-1');
    // Subgraph visibility tag present with depth 1 + resolved name.
    expect(captured.data._subgraph).toEqual({
      depth: 1,
      graphId: 'sub-graph',
      name: 'Sub Graph',
    });
    // Trigger metadata still flags this as a subgraph run.
    expect(captured.data.input._trigger.type).toBe('subgraph');
    expect(captured.data.input._trigger.metadata.parentRunId).toBe('parent-run-1');
  });

  it('nested subgraph (depth 2) increments _subgraph.depth', async () => {
    let captured: any;
    const fakeRegistry = {
      getGraph: vi.fn(async () => ({
        graph: { invoke: vi.fn(async (input: any) => { captured = input; return { data: {} }; }) },
      })),
      getConfig: vi.fn(async () => ({ graphId: 'deep', name: 'Deep' })),
    };
    const parentState = {
      runId: 'parent-run-2',
      userId: 'user-1',
      _subgraphDepth: 1, // already one level deep
      _graphRegistry: fakeRegistry,
      data: { runId: 'parent-run-2', userId: 'user-1', options: { runId: 'parent-run-2' } },
    };

    await executeGraph(
      { graphId: 'deep', outputField: 'data.r' },
      parentState,
    );

    expect(captured.data._subgraph.depth).toBe(2);
    expect(captured._subgraphDepth).toBe(2);
  });
});
