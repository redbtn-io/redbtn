/**
 * `invoke_graph` — the SECOND graph-as-tool boundary the taint has to cross.
 *
 * # What this covers
 *
 * `tool-resolver.resolveGraph` stamps `MODEL_DRIVEN_STATE_KEY` on the state it
 * synthesises when a neuron invokes a published graph as a tool, so tool steps
 * inside that sub-graph are untrusted callers and `fetch_url` refuses them the
 * platform's `X-Internal-Key`.
 *
 * `invoke_graph` reaches the same place by a different road, and round 2 of the
 * review of PR #378 found it unmarked: it is a REGISTERED NATIVE TOOL that a
 * model calls with a model-chosen `graphId` and `input`, and it starts a whole
 * child run through `run()` with no marker at all. Every tool step in that
 * child run was therefore a trusted caller — the original escalation, one
 * indirection further out. Worse, `native-registry` and `caller-trust` both
 * asserted in prose that any step inside a model-invoked sub-graph is
 * untrusted OUTRIGHT, which was false while this path was open.
 *
 * The marker rides on the child `input` because that is the only surface
 * `run()` gives a caller: `buildInitialState` puts it at `state.data.input`,
 * which `isModelDrivenState` reads.
 *
 * Mocking follows `tests/tools/invoke-graph.test.ts`: `mongoose` and the
 * engine's `run()` are both stubbed, so this is hermetic — no MongoDB, no
 * LangGraph.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import {
  MODEL_DRIVEN_STATE_KEY,
  isModelDrivenState,
  markStateModelDriven,
} from '../../src/lib/tools/caller-trust';

const GRAPH_FIXTURE = { graphId: 'g-child', userId: 'user-1', name: 'child' };

const mockState: { runSpy: ReturnType<typeof vi.fn> } = { runSpy: vi.fn() };

vi.mock('mongoose', () => {
  const connection = {
    db: {
      collection() {
        return { async findOne() { return GRAPH_FIXTURE; } };
      },
    },
  };
  return { default: { connection }, connection };
});

vi.mock('../../src/functions/run', () => ({
  run: (...args: unknown[]) => mockState.runSpy(...args),
  isStreamingResult: () => false,
}));

function makeContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: { redis: {}, user: 'user-1', toolProgress: vi.fn().mockResolvedValue(undefined) } as never,
    state: {
      userId: 'user-1',
      neuronRegistry: {},
      memory: {},
      _graphRegistry: {},
      mcpClient: { callTool: async () => ({}) },
      data: { userId: 'user-1' },
    },
    runId: 'parent-run',
    nodeId: 'parent-node',
    toolId: 'parent-tool',
    abortSignal: null,
    ...overrides,
  } as NativeToolContext;
}

/** The `input` argument `invoke_graph` handed `run()`. */
function childInput(): Record<string, unknown> {
  expect(mockState.runSpy).toHaveBeenCalledTimes(1);
  return mockState.runSpy.mock.calls[0][1] as Record<string, unknown>;
}

let invokeGraphTool: typeof import('../../src/lib/tools/native/invoke-graph').default;

beforeEach(async () => {
  mockState.runSpy = vi.fn(async (_red: unknown, _input: unknown, options: { runId?: string }) => ({
    runId: options?.runId ?? 'child-run',
    status: 'completed' as const,
    content: 'done',
    data: {},
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  invokeGraphTool = (await import('../../src/lib/tools/native/invoke-graph')).default;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('invoke_graph — the model-driven taint crosses into the child run', () => {
  test('an UNTRUSTED caller (the neuron tool-use loop) taints the child run', async () => {
    const r = await invokeGraphTool.handler(
      { graphId: 'g-child', input: { question: 'what is at that URL?' } },
      makeContext({ untrustedCaller: true }),
    );
    expect(r.isError).not.toBe(true);

    const input = childInput();
    expect(input[MODEL_DRIVEN_STATE_KEY]).toBe(true);
    // ...and the state the child's tool steps will see is judged model-driven,
    // which is the assertion that actually gates `fetch_url`.
    expect(isModelDrivenState({ data: { input } })).toBe(true);
  });

  test('an already-tainted parent run taints the child too', async () => {
    // Depth 2 of the same escalation: a model invoked a sub-graph, and that
    // sub-graph calls invoke_graph. Nothing about THIS call is untrusted per
    // se; the run it happens in is.
    await invokeGraphTool.handler(
      { graphId: 'g-child', input: {} },
      makeContext({
        state: markStateModelDriven(makeContext().state as Record<string, unknown>) as never,
      }),
    );
    expect(childInput()[MODEL_DRIVEN_STATE_KEY]).toBe(true);
  });

  test('a model cannot CLEAR the taint through the input it chose', async () => {
    // `input` is model-supplied, so it must not be able to unset the marker.
    // It is stamped after the spread, so the model can only ever add it.
    await invokeGraphTool.handler(
      { graphId: 'g-child', input: { [MODEL_DRIVEN_STATE_KEY]: false } },
      makeContext({ untrustedCaller: true }),
    );
    expect(childInput()[MODEL_DRIVEN_STATE_KEY]).toBe(true);
  });

  test('a TRUSTED authored step is not tainted — composing graphs still works', async () => {
    // A graph author writing `{ toolName:'invoke_graph', parameters:{ graphId:'g-child' } }`
    // with literal parameters is composing graphs, exactly like a `graph`
    // step. Blanket-tainting would silently strip internal auth from every
    // authored composition, which is an availability regression, not a fix.
    await invokeGraphTool.handler({ graphId: 'g-child', input: {} }, makeContext());

    const input = childInput();
    expect(input[MODEL_DRIVEN_STATE_KEY]).toBeUndefined();
    expect(isModelDrivenState({ data: { input } })).toBe(false);
  });

  test('the linkage metadata the tool already carried is untouched', async () => {
    await invokeGraphTool.handler(
      { graphId: 'g-child', input: { q: 1 } },
      makeContext({ untrustedCaller: true }),
    );
    const input = childInput();
    expect(input.q).toBe(1);
    expect(input.parentRunId).toBe('parent-run');
    expect(input._invokeGraphDepth).toBe(1);
    expect((input._trigger as { type: string }).type).toBe('invoke_graph');
  });

  test('wait:false takes the same marking — the detached path is not a bypass', async () => {
    await invokeGraphTool.handler(
      { graphId: 'g-child', input: {}, wait: false },
      makeContext({ untrustedCaller: true }),
    );
    expect(childInput()[MODEL_DRIVEN_STATE_KEY]).toBe(true);
  });
});

describe('isModelDrivenState — reading the marker off a child run input', () => {
  test('recognises the marker at every level a sub-run can preserve', () => {
    expect(isModelDrivenState({ [MODEL_DRIVEN_STATE_KEY]: true })).toBe(true);
    expect(isModelDrivenState({ data: { [MODEL_DRIVEN_STATE_KEY]: true } })).toBe(true);
    expect(isModelDrivenState({ data: { input: { [MODEL_DRIVEN_STATE_KEY]: true } } })).toBe(true);
    expect(isModelDrivenState({ input: { [MODEL_DRIVEN_STATE_KEY]: true } })).toBe(true);
  });

  test('still refuses truthy-but-not-true and ordinary states', () => {
    expect(isModelDrivenState({ data: { input: { [MODEL_DRIVEN_STATE_KEY]: 'yes' } } })).toBe(false);
    expect(isModelDrivenState({ data: { input: { q: 1 } } })).toBe(false);
    expect(isModelDrivenState({ data: {} })).toBe(false);
  });
});
