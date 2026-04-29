/**
 * Vitest for native tool: invoke_graph
 *
 * Per TOOL-HANDOFF.md §6.1 — exhaustive coverage of the showstopper:
 *   - happy path (small graph, wait:true, completes)
 *   - recursion-limit error (depth 5+1)
 *   - access-denied error
 *   - timeout behaviour (wait:true with too-short timeout)
 *   - wait:false returns runId fast
 *
 * The handler does two side-effecting things at runtime:
 *   1. Reads the graphs collection via `require('mongoose')`.
 *   2. Calls the engine's `run()` via `require('../../../functions/run')`.
 *
 * We mock both via vi.mock so the test is hermetic — no MongoDB or LangGraph
 * needed in CI.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

// ── Mock state — shared between mocks and tests ────────────────────────────
type GraphFixture = Record<string, unknown> | null;

interface RunFixture {
  resolveAfterMs?: number;
  result?: {
    runId: string;
    status: 'completed' | 'error' | 'interrupted';
    content?: string;
    thinking?: string;
    data?: Record<string, unknown>;
    error?: string;
    interruptedReason?: string;
  };
  reject?: Error;
}

const mockState: {
  graphFixture: GraphFixture;
  runFixture: RunFixture;
  runSpy: ReturnType<typeof vi.fn>;
} = {
  graphFixture: null,
  runFixture: {},
  runSpy: vi.fn(),
};

// ── Mocks (must be at top level for vitest to hoist) ───────────────────────
vi.mock('mongoose', () => {
  return {
    default: {
      get connection() {
        return {
          db: {
            collection(name: string) {
              if (name === 'graphs') {
                return {
                  async findOne() {
                    return mockState.graphFixture;
                  },
                };
              }
              return { async findOne() { return null; } };
            },
          },
        };
      },
    },
    get connection() {
      return {
        db: {
          collection(name: string) {
            if (name === 'graphs') {
              return {
                async findOne() {
                  return mockState.graphFixture;
                },
              };
            }
            return { async findOne() { return null; } };
          },
        },
      };
    },
  };
});

vi.mock('../../src/functions/run', () => ({
  run: (...args: unknown[]) => mockState.runSpy(...args),
  isStreamingResult: () => false,
}));

// ── Helpers ───────────────────────────────────────────────────────────────
function makeMockPublisher() {
  return {
    redis: { /* not actually used by invoke_graph internals — just must exist */ },
    redlog: undefined,
    toolProgress: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  // Create a default mock publisher so buildRedShape() finds redis.
  const defaultPublisher = makeMockPublisher();
  return {
    publisher: defaultPublisher as unknown as NativeToolContext['publisher'],
    state: {
      // Base state must carry userId AND the engine surfaces invoke_graph
      // needs to construct a Red-shaped duck object.
      userId: 'user-1',
      neuronRegistry: {},
      memory: {},
      _graphRegistry: {},
      mcpClient: { callTool: async () => ({}) },
      data: {
        userId: 'user-1',
      },
    },
    runId: 'parent-run-' + Date.now(),
    nodeId: 'parent-node',
    toolId: 'parent-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

function setRunBehaviour(opts: RunFixture) {
  mockState.runFixture = opts;
  mockState.runSpy = vi.fn(async (...args: unknown[]) => {
    const options = args[2] as { runId?: string };
    if (opts.reject) throw opts.reject;
    if (opts.resolveAfterMs && opts.resolveAfterMs > 0) {
      await new Promise((r) => setTimeout(r, opts.resolveAfterMs));
    }
    return (
      opts.result ?? {
        runId: options?.runId ?? 'child-run-x',
        status: 'completed' as const,
        content: 'Hello from child',
        thinking: '',
        data: { ok: true },
      }
    );
  });
}

function setGraphFixture(fixture: GraphFixture) {
  mockState.graphFixture = fixture;
}

let invokeGraphTool: typeof import('../../src/lib/tools/native/invoke-graph').default;

beforeEach(async () => {
  // Reset state but keep the module mocks intact.
  mockState.graphFixture = null;
  mockState.runFixture = {};
  mockState.runSpy = vi.fn();
  invokeGraphTool = (
    await import('../../src/lib/tools/native/invoke-graph')
  ).default;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('invoke_graph — schema', () => {
  test('requires graphId + input', () => {
    expect(invokeGraphTool.description.toLowerCase()).toContain('invoke');
    expect(invokeGraphTool.inputSchema.required).toEqual(['graphId', 'input']);
    expect(invokeGraphTool.inputSchema.properties.wait).toBeDefined();
    expect(invokeGraphTool.inputSchema.properties.timeoutMs).toBeDefined();
  });
});

describe('invoke_graph — validation', () => {
  test('missing graphId returns isError + VALIDATION code', async () => {
    const r = await invokeGraphTool.handler({ input: {} }, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/graphId/);
  });

  test('missing input returns isError + VALIDATION', async () => {
    const r = await invokeGraphTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('non-object input returns isError + VALIDATION', async () => {
    const r = await invokeGraphTool.handler(
      { graphId: 'g1', input: 'not-an-object' as unknown },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing userId in state returns isError', async () => {
    const r = await invokeGraphTool.handler(
      { graphId: 'g1', input: {} },
      makeMockContext({ state: { neuronRegistry: {}, memory: {}, _graphRegistry: {} } }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/userId/);
  });
});

describe('invoke_graph — recursion limit', () => {
  test('depth 5 + 1 = 6 → recursion_limit_exceeded', async () => {
    const r = await invokeGraphTool.handler(
      { graphId: 'g1', input: {} },
      makeMockContext({
        state: {
          userId: 'user-1',
          _invokeGraphDepth: 5,
          data: { userId: 'user-1' },
          neuronRegistry: {},
          memory: {},
          _graphRegistry: {},
          mcpClient: { callTool: async () => ({}) },
        },
      }),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toBe('recursion_limit_exceeded');
    expect(body.depth).toBe(6);
    expect(body.maxDepth).toBe(5);
  });

  test('depth 4 + 1 = 5 → still allowed (boundary)', async () => {
    setGraphFixture({
      graphId: 'g1',
      userId: 'user-1',
      isPublic: false,
      isSystem: false,
      participants: [],
    });
    setRunBehaviour({
      result: {
        runId: 'child-1',
        status: 'completed',
        content: 'done',
      },
    });

    const r = await invokeGraphTool.handler(
      { graphId: 'g1', input: { hello: 'world' } },
      makeMockContext({
        state: {
          userId: 'user-1',
          _invokeGraphDepth: 4,
          data: { userId: 'user-1' },
          neuronRegistry: {},
          memory: {},
          _graphRegistry: {},
          mcpClient: { callTool: async () => ({}) },
        },
      }),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.depth).toBe(5);
    // Verify the child run inherited the depth in input
    expect(mockState.runSpy).toHaveBeenCalledTimes(1);
    const passedInput = mockState.runSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(passedInput._invokeGraphDepth).toBe(5);
  });
});

describe('invoke_graph — access check', () => {
  test('caller is owner → access granted', async () => {
    setGraphFixture({
      graphId: 'g1',
      userId: 'user-1',
      participants: [],
    });
    setRunBehaviour({
      result: {
        runId: 'child-1',
        status: 'completed',
        content: 'ok',
      },
    });

    const r = await invokeGraphTool.handler(
      { graphId: 'g1', input: {} },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).status).toBe('completed');
  });

  test('caller is participant (member) → access granted', async () => {
    setGraphFixture({
      graphId: 'g1',
      userId: 'someone-else',
      participants: [{ userId: 'user-1', role: 'member' }],
    });
    setRunBehaviour({
      result: {
        runId: 'child-2',
        status: 'completed',
      },
    });

    const r = await invokeGraphTool.handler(
      { graphId: 'g1', input: {} },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
  });

  test('public graph → access granted (viewer role)', async () => {
    setGraphFixture({
      graphId: 'g-public',
      userId: 'someone-else',
      isPublic: true,
      participants: [],
    });
    setRunBehaviour({
      result: {
        runId: 'child-3',
        status: 'completed',
      },
    });

    const r = await invokeGraphTool.handler(
      { graphId: 'g-public', input: {} },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
  });

  test('system graph → access granted', async () => {
    setGraphFixture({
      graphId: 'red-assistant',
      userId: 'system',
      isSystem: true,
      participants: [],
    });
    setRunBehaviour({
      result: {
        runId: 'child-4',
        status: 'completed',
      },
    });

    const r = await invokeGraphTool.handler(
      { graphId: 'red-assistant', input: { message: 'hi' } },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
  });

  test('not owner, not participant, not public, not system → access_denied', async () => {
    setGraphFixture({
      graphId: 'g-private',
      userId: 'someone-else',
      isPublic: false,
      isSystem: false,
      participants: [],
    });

    const r = await invokeGraphTool.handler(
      { graphId: 'g-private', input: {} },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toBe('access_denied');
    expect(body.graphId).toBe('g-private');
  });

  test('graph does not exist → graph_not_found', async () => {
    setGraphFixture(null);

    const r = await invokeGraphTool.handler(
      { graphId: 'nope', input: {} },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toBe('graph_not_found');
  });
});

describe('invoke_graph — wait:true happy path', () => {
  test('returns { runId, output, status, durationMs } on completion', async () => {
    setGraphFixture({
      graphId: 'g1',
      userId: 'user-1',
      participants: [],
    });
    setRunBehaviour({
      result: {
        runId: 'child-happy',
        status: 'completed',
        content: 'Hello world',
        thinking: 'Let me think',
        data: { greeting: 'world' },
      },
    });

    const r = await invokeGraphTool.handler(
      { graphId: 'g1', input: { who: 'world' } },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.runId).toBe('child-happy');
    expect(body.status).toBe('completed');
    expect(body.output.content).toBe('Hello world');
    expect(body.output.data).toEqual({ greeting: 'world' });
    expect(typeof body.durationMs).toBe('number');
    expect(body.depth).toBe(1); // first invocation (parent depth 0)
  });

  test('parent linkage: child input carries parentRunId + _invokeGraphDepth', async () => {
    setGraphFixture({
      graphId: 'g1',
      userId: 'user-1',
      participants: [],
    });
    setRunBehaviour({
      result: { runId: 'child-link', status: 'completed' },
    });

    const parentRunId = 'parent-run-abc-123';
    await invokeGraphTool.handler(
      { graphId: 'g1', input: { custom: 'value' } },
      makeMockContext({
        runId: parentRunId,
        state: {
          userId: 'user-1',
          runId: parentRunId,
          neuronRegistry: {},
          memory: {},
          _graphRegistry: {},
          mcpClient: { callTool: async () => ({}) },
          data: { userId: 'user-1', runId: parentRunId },
        },
      }),
    );

    expect(mockState.runSpy).toHaveBeenCalledTimes(1);
    const passedInput = mockState.runSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(passedInput.parentRunId).toBe(parentRunId);
    expect(passedInput._invokeGraphDepth).toBe(1);
    expect(passedInput.custom).toBe('value');
    expect(passedInput._trigger).toMatchObject({
      type: 'invoke_graph',
    });
  });

  test('child run failure surfaces as isError: true with status: error', async () => {
    setGraphFixture({
      graphId: 'g1',
      userId: 'user-1',
      participants: [],
    });
    setRunBehaviour({
      result: {
        runId: 'child-fail',
        status: 'error',
        error: 'graph blew up',
      },
    });

    const r = await invokeGraphTool.handler(
      { graphId: 'g1', input: {} },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe('error');
    expect(body.output.error).toBe('graph blew up');
  });
});

describe('invoke_graph — timeout', () => {
  test('wait:true with timeout exceeded → status:timeout, no cancel', async () => {
    setGraphFixture({
      graphId: 'g1',
      userId: 'user-1',
      participants: [],
    });
    setRunBehaviour({
      resolveAfterMs: 5_000, // child takes 5s
      result: { runId: 'child-slow', status: 'completed' },
    });

    const start = Date.now();
    const r = await invokeGraphTool.handler(
      { graphId: 'g1', input: {}, timeoutMs: 1000 },
      makeMockContext(),
    );
    const elapsed = Date.now() - start;

    expect(r.isError).toBeFalsy(); // timeout is not an error per spec
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe('timeout');
    expect(body.output).toBeNull();
    expect(body.durationMs).toBe(1000);
    // Should have returned shortly after the timeout fired (allow 500ms slack
    // for runtime overhead — but it shouldn't take the full 5s).
    expect(elapsed).toBeLessThan(2500);
    expect(body.runId).toBeDefined(); // runId always returned
  });
});

describe('invoke_graph — wait:false', () => {
  test('returns immediately with runId and status:submitted', async () => {
    setGraphFixture({
      graphId: 'g1',
      userId: 'user-1',
      participants: [],
    });
    setRunBehaviour({
      resolveAfterMs: 5_000, // would block 5s if we awaited
      result: { runId: 'child-async', status: 'completed' },
    });

    const start = Date.now();
    const r = await invokeGraphTool.handler(
      { graphId: 'g1', input: { msg: 'fire and forget' }, wait: false },
      makeMockContext(),
    );
    const elapsed = Date.now() - start;

    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe('submitted');
    expect(body.wait).toBe(false);
    expect(body.runId).toBeDefined();
    expect(body.depth).toBe(1);
    // Should return well before the 5s child completes
    expect(elapsed).toBeLessThan(1000);
  });
});
