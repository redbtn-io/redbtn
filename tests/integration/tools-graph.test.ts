/**
 * Integration test for the native graph pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a small
 * graph using the new tools end-to-end."
 *
 * The graph pack is unique among the packs because it is genuinely
 * recursive — `invoke_graph` invokes the engine itself. A real end-to-end
 * test would need MongoDB, Redis, LangGraph, the neuron registry, the MCP
 * client, ChromaDB, and a working graph compiler all up. That's not the
 * level we test at here — that's a smoke-test concern.
 *
 * Instead, this integration test exercises the realistic agent lifecycle:
 *
 *   1. NativeToolRegistry singleton has all 3 graph-pack tools registered.
 *   2. A simulated "agent" runs the canonical chain a chat-driven LLM
 *      would run: discover → inspect → invoke.
 *
 *        list_graphs   — discover what graphs are accessible
 *        get_graph     — inspect input schema of a chosen graph
 *        invoke_graph  — actually call the chosen graph
 *
 * Both `list_graphs` and `get_graph` are mocked at the fetch layer because
 * they're plain HTTP API proxies. `invoke_graph` is mocked at the engine
 * layer (`mongoose` + dynamic `run` import) because it goes in-process.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';

// Re-import each tool by path. In production, native-registry.ts loads each
// via require('./native/foo.js'); when running TS sources under vitest those
// .js paths don't exist next to the .ts module, so the catch block silently
// swallows the failure. We work around it by importing the TS modules and
// explicitly re-registering them with the singleton.
import listGraphsTool from '../../src/lib/tools/native/list-graphs';
import getGraphTool from '../../src/lib/tools/native/get-graph';
import invokeGraphTool from '../../src/lib/tools/native/invoke-graph';

const WEBAPP = 'http://test-webapp.example';

// ── Shared mock state — identical pattern to invoke-graph.test.ts ─────────
type GraphFixture = Record<string, unknown> | null;

const mockState: {
  graphFixture: GraphFixture;
  runSpy: ReturnType<typeof vi.fn>;
} = {
  graphFixture: null,
  runSpy: vi.fn(),
};

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

function makeMockPublisher() {
  return {
    redis: {},
    redlog: undefined,
    toolProgress: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  const defaultPublisher = makeMockPublisher();
  return {
    publisher: defaultPublisher as unknown as NativeToolContext['publisher'],
    state: {
      userId: 'user-int',
      neuronRegistry: {},
      memory: {},
      _graphRegistry: {},
      mcpClient: { callTool: async () => ({}) },
      data: { userId: 'user-int' },
    },
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

function setRunResult(result: {
  runId: string;
  status: 'completed' | 'error' | 'interrupted';
  content?: string;
  data?: Record<string, unknown>;
}) {
  mockState.runSpy = vi.fn(async () => result);
}

describe('graph pack integration — registration + chained execution', () => {
  beforeAll(() => {
    const registry = getNativeRegistry();
    if (!registry.has('list_graphs')) registry.register('list_graphs', listGraphsTool);
    if (!registry.has('get_graph')) registry.register('get_graph', getGraphTool);
    if (!registry.has('invoke_graph')) registry.register('invoke_graph', invokeGraphTool);
  });

  beforeEach(() => {
    mockState.graphFixture = null;
    mockState.runSpy = vi.fn();
  });

  test('NativeToolRegistry has all 3 graph-pack tools registered', () => {
    const registry = getNativeRegistry();
    for (const name of ['list_graphs', 'get_graph', 'invoke_graph']) {
      expect(registry.has(name)).toBe(true);
    }

    // All three share the 'graph' server label
    for (const name of ['list_graphs', 'get_graph', 'invoke_graph']) {
      expect(registry.get(name)?.server).toBe('graph');
    }
  });

  describe('end-to-end: list_graphs → get_graph → invoke_graph', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      process.env.WEBAPP_URL = WEBAPP;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    test('agent discovers, inspects, and invokes a system graph', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      // ── 1. list_graphs ───────────────────────────────────────────────────
      // Mock the GET /api/v1/graphs response.
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        if (url.includes('/api/v1/graphs?')) {
          return new Response(
            JSON.stringify({
              graphs: [
                {
                  graphId: 'red-assistant',
                  name: 'Red Assistant',
                  description: 'Default chat graph',
                  isOwned: false,
                  isSystem: true,
                },
                {
                  graphId: 'red-chat',
                  name: 'Red Chat',
                  description: 'Simple chat',
                  isOwned: false,
                  isSystem: true,
                },
                {
                  graphId: 'my-fork',
                  name: 'My Fork',
                  description: 'Personal',
                  isOwned: true,
                  isSystem: false,
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes('/api/v1/graphs/red-assistant')) {
          return new Response(
            JSON.stringify({
              graph: {
                graphId: 'red-assistant',
                name: 'Red Assistant',
                description: 'Default chat graph',
                inputSchema: [
                  {
                    name: 'message',
                    type: 'string',
                    required: true,
                    description: 'User message to respond to',
                  },
                ],
                nodes: [{ id: 'context' }, { id: 'router' }, { id: 'respond' }],
                edges: [
                  { from: 'context', to: 'router' },
                  { from: 'router', to: 'respond' },
                ],
                isSystem: true,
              },
            }),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof globalThis.fetch;

      const listResult = await registry.callTool('list_graphs', {}, ctx);
      expect(listResult.isError).toBeFalsy();
      const listBody = JSON.parse(listResult.content[0].text);
      expect(listBody.graphs).toHaveLength(3);
      const chosenGraph = listBody.graphs.find(
        (g: { graphId: string }) => g.graphId === 'red-assistant',
      );
      expect(chosenGraph).toBeDefined();
      expect(chosenGraph.isSystem).toBe(true);

      // ── 2. get_graph — inspect the input schema before invoking ──────────
      const getResult = await registry.callTool(
        'get_graph',
        { graphId: chosenGraph.graphId },
        ctx,
      );
      expect(getResult.isError).toBeFalsy();
      const getBody = JSON.parse(getResult.content[0].text);
      expect(getBody.graph.graphId).toBe('red-assistant');
      expect(getBody.graph.inputSchema).toBeDefined();
      expect(getBody.graph.inputSchema[0].name).toBe('message');

      // The agent now knows it needs to provide `{ message: string }`.
      const requiredFieldName = getBody.graph.inputSchema[0].name;
      expect(requiredFieldName).toBe('message');

      // ── 3. invoke_graph — call the discovered graph ──────────────────────
      mockState.graphFixture = {
        graphId: 'red-assistant',
        userId: 'system',
        isSystem: true,
        participants: [],
      };
      setRunResult({
        runId: 'child-from-integration',
        status: 'completed',
        content: 'Hello, world!',
        data: { invokedBy: 'integration test' },
      });

      const invokeResult = await registry.callTool(
        'invoke_graph',
        {
          graphId: 'red-assistant',
          input: { [requiredFieldName]: 'Hi from agent' },
        },
        ctx,
      );
      expect(invokeResult.isError).toBeFalsy();
      const invokeBody = JSON.parse(invokeResult.content[0].text);
      expect(invokeBody.runId).toBe('child-from-integration');
      expect(invokeBody.status).toBe('completed');
      expect(invokeBody.output.content).toBe('Hello, world!');
      expect(invokeBody.depth).toBe(1);

      // Verify run() was called with the agent's payload + parent linkage.
      expect(mockState.runSpy).toHaveBeenCalledTimes(1);
      const passedInput = mockState.runSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(passedInput.message).toBe('Hi from agent');
      expect(passedInput._invokeGraphDepth).toBe(1);
      expect(passedInput._trigger).toMatchObject({ type: 'invoke_graph' });
    });

    test('agent flow handles graph_not_found at invoke step', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ graphs: [] }), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const listResult = await registry.callTool('list_graphs', {}, ctx);
      expect(listResult.isError).toBeFalsy();

      // Agent then tries to invoke a graph that doesn't exist
      mockState.graphFixture = null;

      const invokeResult = await registry.callTool(
        'invoke_graph',
        { graphId: 'phantom', input: {} },
        ctx,
      );
      expect(invokeResult.isError).toBe(true);
      expect(JSON.parse(invokeResult.content[0].text).error).toBe(
        'graph_not_found',
      );
    });

    test('agent flow honours access_denied for private graphs they don\'t own', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      globalThis.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            graphs: [{ graphId: 'g-private', name: 'Other', isOwned: false, isSystem: false }],
          }),
          { status: 200 },
        ),
      ) as unknown as typeof globalThis.fetch;

      await registry.callTool('list_graphs', {}, ctx);

      mockState.graphFixture = {
        graphId: 'g-private',
        userId: 'someone-else',
        isPublic: false,
        isSystem: false,
        participants: [],
      };

      const invokeResult = await registry.callTool(
        'invoke_graph',
        { graphId: 'g-private', input: {} },
        ctx,
      );
      expect(invokeResult.isError).toBe(true);
      const body = JSON.parse(invokeResult.content[0].text);
      expect(body.error).toBe('access_denied');
      expect(body.graphId).toBe('g-private');
    });
  });
});
