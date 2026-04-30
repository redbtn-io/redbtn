/**
 * Integration test for the native platform pack (Phase A).
 *
 * Per PLATFORM-PACK-HANDOFF.md §7 — chains create → update → fork → delete
 * end-to-end against a mocked webapp, verifying:
 *   1. The 18 platform-pack tools are registered with server: 'platform'
 *   2. The agent loop create_graph → update_graph → fork_graph → delete_graph
 *      flows cleanly and each tool produces output that's usable by the next.
 *   3. delete_graph's system-asset protection trips when fed an isSystem graph.
 *
 * All 18 tools are registered explicitly here (the production registry block
 * uses require('./native/foo.js') which doesn't resolve under tsx/vitest), and
 * fetch is stubbed at the global level for each step.
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

// Re-import every platform-pack tool module by path so we can register them
// against the singleton from a TS-source vitest run.
import createGraphTool from '../../src/lib/tools/native/create-graph';
import updateGraphTool from '../../src/lib/tools/native/update-graph';
import deleteGraphTool from '../../src/lib/tools/native/delete-graph';
import forkGraphTool from '../../src/lib/tools/native/fork-graph';
import publishGraphTool from '../../src/lib/tools/native/publish-graph';
import validateGraphConfigTool from '../../src/lib/tools/native/validate-graph-config';
import getGraphCompileLogTool from '../../src/lib/tools/native/get-graph-compile-log';
import createNodeTool from '../../src/lib/tools/native/create-node';
import updateNodeTool from '../../src/lib/tools/native/update-node';
import deleteNodeTool from '../../src/lib/tools/native/delete-node';
import forkNodeTool from '../../src/lib/tools/native/fork-node';
import createNeuronTool from '../../src/lib/tools/native/create-neuron';
import updateNeuronTool from '../../src/lib/tools/native/update-neuron';
import deleteNeuronTool from '../../src/lib/tools/native/delete-neuron';
import forkNeuronTool from '../../src/lib/tools/native/fork-neuron';
import createStreamTool from '../../src/lib/tools/native/create-stream';
import updateStreamTool from '../../src/lib/tools/native/update-stream';
import deleteStreamTool from '../../src/lib/tools/native/delete-stream';

const WEBAPP = 'http://test-webapp.example';

const ALL_TOOLS = [
  ['create_graph', createGraphTool],
  ['update_graph', updateGraphTool],
  ['delete_graph', deleteGraphTool],
  ['fork_graph', forkGraphTool],
  ['publish_graph', publishGraphTool],
  ['validate_graph_config', validateGraphConfigTool],
  ['get_graph_compile_log', getGraphCompileLogTool],
  ['create_node', createNodeTool],
  ['update_node', updateNodeTool],
  ['delete_node', deleteNodeTool],
  ['fork_node', forkNodeTool],
  ['create_neuron', createNeuronTool],
  ['update_neuron', updateNeuronTool],
  ['delete_neuron', deleteNeuronTool],
  ['fork_neuron', forkNeuronTool],
  ['create_stream', createStreamTool],
  ['update_stream', updateStreamTool],
  ['delete_stream', deleteStreamTool],
] as const;

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'agent-int' },
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('platform pack — registration', () => {
  beforeAll(() => {
    const registry = getNativeRegistry();
    for (const [name, tool] of ALL_TOOLS) {
      if (!registry.has(name)) registry.register(name, tool);
    }
  });

  test('all 18 platform-pack tools are registered', () => {
    const registry = getNativeRegistry();
    for (const [name] of ALL_TOOLS) {
      expect(registry.has(name)).toBe(true);
    }
  });

  test('every platform-pack tool advertises server: "platform"', () => {
    const registry = getNativeRegistry();
    for (const [name] of ALL_TOOLS) {
      expect(registry.get(name)?.server).toBe('platform');
    }
  });

  test('Phase A stubs (validate_graph_config, get_graph_compile_log) return NOT_IMPLEMENTED', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    const v = await registry.callTool('validate_graph_config', { config: { name: 'X' } }, ctx);
    expect(v.isError).toBe(true);
    expect(JSON.parse(v.content[0].text).code).toBe('NOT_IMPLEMENTED');

    const c = await registry.callTool('get_graph_compile_log', { graphId: 'g1' }, ctx);
    expect(c.isError).toBe(true);
    expect(JSON.parse(c.content[0].text).code).toBe('NOT_IMPLEMENTED');
  });
});

describe('platform pack — graph CRUD loop (create → update → fork → delete)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    const registry = getNativeRegistry();
    for (const [name, tool] of ALL_TOOLS) {
      if (!registry.has(name)) registry.register(name, tool);
    }
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = WEBAPP;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('agent chains create → update → fork → delete and each step uses prior output', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext({ state: { authToken: 'jwt-int' } });

    // Track the simulated server-side state across calls
    const state: { graphs: Record<string, any> } = { graphs: {} };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const method = (init?.method || 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      // POST /api/v1/graphs (create)
      if (method === 'POST' && url === `${WEBAPP}/api/v1/graphs`) {
        const id = body.graphId || 'g_int_001';
        state.graphs[id] = {
          graphId: id,
          name: body.name,
          userId: 'agent-int',
          isSystem: false,
        };
        return new Response(JSON.stringify({ graphId: id, name: body.name, createdAt: '2026-04-27T12:00:00Z' }), { status: 201 });
      }

      // PATCH /api/v1/graphs/:graphId (update)
      const patchMatch = url.match(/^\S+?\/api\/v1\/graphs\/([^/]+)$/);
      if (method === 'PATCH' && patchMatch) {
        const id = decodeURIComponent(patchMatch[1]);
        if (state.graphs[id]) {
          if (body.name !== undefined) state.graphs[id].name = body.name;
          return new Response(JSON.stringify({ graphId: id, cloned: false, name: state.graphs[id].name, updatedAt: 'now' }), { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      }

      // POST /api/v1/graphs/:graphId/fork
      const forkMatch = url.match(/^\S+?\/api\/v1\/graphs\/([^/]+)\/fork$/);
      if (method === 'POST' && forkMatch) {
        const parentId = decodeURIComponent(forkMatch[1]);
        const forkId = body.newGraphId || `${parentId}_fork`;
        if (state.graphs[parentId]) {
          state.graphs[forkId] = {
            graphId: forkId,
            name: body.name || `${state.graphs[parentId].name} (Fork)`,
            userId: 'agent-int',
            isSystem: false,
            parentGraphId: parentId,
          };
          return new Response(JSON.stringify({ graphId: forkId, parentGraphId: parentId, name: state.graphs[forkId].name, createdAt: 'now' }), { status: 201 });
        }
        return new Response('Not Found', { status: 404 });
      }

      // GET /api/v1/graphs/:graphId (peek for delete safety check)
      const getMatch = url.match(/^\S+?\/api\/v1\/graphs\/([^/]+)$/);
      if (method === 'GET' && getMatch) {
        const id = decodeURIComponent(getMatch[1]);
        if (state.graphs[id]) {
          return new Response(JSON.stringify({ graph: state.graphs[id] }), { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      }

      // DELETE /api/v1/graphs/:graphId
      const deleteMatch = url.match(/^\S+?\/api\/v1\/graphs\/([^/]+)$/);
      if (method === 'DELETE' && deleteMatch) {
        const id = decodeURIComponent(deleteMatch[1]);
        if (state.graphs[id]) {
          delete state.graphs[id];
          return new Response(JSON.stringify({ success: true, graphId: id }), { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      }

      return new Response('unhandled mock URL: ' + url, { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    // ── 1. create_graph
    const createR = await registry.callTool('create_graph', {
      config: {
        name: 'Hello Workflow',
        nodes: [{ id: 'context' }, { id: 'respond' }],
        edges: [{ from: 'context', to: 'respond' }],
      },
    }, ctx);
    expect(createR.isError).toBeFalsy();
    const createBody = JSON.parse(createR.content[0].text);
    expect(createBody.graphId).toBe('g_int_001');
    expect(createBody.name).toBe('Hello Workflow');

    // ── 2. update_graph using ID from step 1
    const updateR = await registry.callTool('update_graph', {
      graphId: createBody.graphId,
      patch: { name: 'Hello Workflow v2' },
    }, ctx);
    expect(updateR.isError).toBeFalsy();
    const updateBody = JSON.parse(updateR.content[0].text);
    expect(updateBody.ok).toBe(true);
    expect(updateBody.graphId).toBe(createBody.graphId);

    // ── 3. fork_graph using ID from step 1/2
    const forkR = await registry.callTool('fork_graph', {
      graphId: createBody.graphId,
      newGraphId: 'g_int_001_fork',
      name: 'Hello Workflow Fork',
    }, ctx);
    expect(forkR.isError).toBeFalsy();
    const forkBody = JSON.parse(forkR.content[0].text);
    expect(forkBody.graphId).toBe('g_int_001_fork');
    expect(forkBody.forkedFrom).toBe(createBody.graphId);

    // ── 4. delete_graph the fork
    const deleteR = await registry.callTool('delete_graph', { graphId: forkBody.graphId }, ctx);
    expect(deleteR.isError).toBeFalsy();
    const deleteBody = JSON.parse(deleteR.content[0].text);
    expect(deleteBody.ok).toBe(true);
    expect(deleteBody.graphId).toBe(forkBody.graphId);

    // ── Verify final state: original still exists, fork deleted
    expect(state.graphs[createBody.graphId]).toBeDefined();
    expect(state.graphs[forkBody.graphId]).toBeUndefined();
  });

  test('delete_graph REFUSES system graphs without ever calling DELETE', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    let deleteHit = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'GET' && url === `${WEBAPP}/api/v1/graphs/red-assistant`) {
        return new Response(JSON.stringify({
          graph: { graphId: 'red-assistant', userId: 'system', isSystem: true },
        }), { status: 200 });
      }
      if (method === 'DELETE') {
        deleteHit = true;
        throw new Error('integration test fail: DELETE called for system graph');
      }
      return new Response('unhandled', { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const r = await registry.callTool('delete_graph', { graphId: 'red-assistant' }, ctx);
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.code).toBe('SYSTEM_ASSET_PROTECTED');
    expect(parsed.error).toMatch(/fork it first/);
    expect(deleteHit).toBe(false);
  });
});
