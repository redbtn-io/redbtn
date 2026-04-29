/**
 * Integration test for the native global-state pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a
 * small graph using the new tools end-to-end."
 *
 * The redbtn graph compiler depends on MongoDB / Redis / LangGraph plumbing
 * which is not always available in CI. This test exercises the layer a graph
 * node actually calls when it runs a `tool` step, in the canonical lifecycle
 * order:
 *
 *   1. The NativeToolRegistry singleton has all 6 global-state tools registered.
 *   2. A simulated multi-step "graph" runs:
 *        set_global_state    → write a value
 *        list_global_state   → confirm the value is in the namespace
 *        get_global_state    → confirm exists: true and value matches
 *        delete_global_state → confirm existed: true
 *        get_global_state    → confirm exists: false after delete
 *
 * The webapp API is mocked via global fetch, with an in-memory backing store
 * that mimics the namespace/values semantics so the chain is observable end
 * to end.
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
import getGlobalStateTool from '../../src/lib/tools/native/get-global-state';
import setGlobalStateTool from '../../src/lib/tools/native/set-global-state';
import deleteGlobalStateTool from '../../src/lib/tools/native/delete-global-state';
import listGlobalStateTool from '../../src/lib/tools/native/list-global-state';
import listNamespacesTool from '../../src/lib/tools/native/list-namespaces';
import deleteNamespaceTool from '../../src/lib/tools/native/delete-namespace';

const WEBAPP = 'http://test-webapp.example';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

/**
 * In-memory mock for the webapp's /api/v1/state API.
 *
 * Routes handled:
 *   GET    /api/v1/state/namespaces
 *   GET    /api/v1/state/namespaces/:ns
 *   DELETE /api/v1/state/namespaces/:ns
 *   GET    /api/v1/state/namespaces/:ns/values
 *   POST   /api/v1/state/namespaces/:ns/values
 *   GET    /api/v1/state/namespaces/:ns/values/:key
 *   DELETE /api/v1/state/namespaces/:ns/values/:key
 */
function createMockStateApi(): typeof globalThis.fetch {
  // namespace -> { entries: { key: value }, lastUpdated }
  const store: Record<
    string,
    { entries: Record<string, unknown>; lastUpdated: string }
  > = {};

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : (input as URL).toString();
    const url = new URL(u);
    const method = (init?.method || 'GET').toUpperCase();
    const path = url.pathname;

    // Match values/:key (single value)
    let m = path.match(
      /^\/api\/v1\/state\/namespaces\/([^/]+)\/values\/([^/]+)$/,
    );
    if (m) {
      const ns = decodeURIComponent(m[1]);
      const key = decodeURIComponent(m[2]);
      if (method === 'GET') {
        const v = store[ns]?.entries[key];
        if (v === undefined) {
          return new Response(JSON.stringify({ error: 'Key not found' }), {
            status: 404,
          });
        }
        return new Response(JSON.stringify({ key, value: v }), { status: 200 });
      }
      if (method === 'DELETE') {
        const existed = store[ns] && key in store[ns].entries;
        if (!existed) {
          return new Response(JSON.stringify({ error: 'Key not found' }), {
            status: 404,
          });
        }
        delete store[ns].entries[key];
        store[ns].lastUpdated = new Date().toISOString();
        return new Response(
          JSON.stringify({ success: true, message: `Key "${key}" deleted` }),
          { status: 200 },
        );
      }
    }

    // Match values (collection)
    m = path.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\/values$/);
    if (m) {
      const ns = decodeURIComponent(m[1]);
      if (method === 'GET') {
        if (!store[ns]) {
          return new Response(JSON.stringify({ values: {} }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ values: store[ns].entries }),
          { status: 200 },
        );
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (!body.key) {
          return new Response(
            JSON.stringify({ error: 'Key is required' }),
            { status: 400 },
          );
        }
        if (!store[ns]) {
          store[ns] = { entries: {}, lastUpdated: new Date().toISOString() };
        }
        store[ns].entries[body.key] = body.value;
        store[ns].lastUpdated = new Date().toISOString();
        return new Response(
          JSON.stringify({ success: true, key: body.key, namespace: ns }),
          { status: 200 },
        );
      }
    }

    // Match namespace detail
    m = path.match(/^\/api\/v1\/state\/namespaces\/([^/]+)$/);
    if (m) {
      const ns = decodeURIComponent(m[1]);
      if (method === 'GET') {
        if (!store[ns]) {
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
          });
        }
        const keys = Object.keys(store[ns].entries);
        return new Response(
          JSON.stringify({
            namespace: ns,
            keyCount: keys.length,
            entries: keys.map(k => ({ key: k, value: store[ns].entries[k] })),
            createdAt: store[ns].lastUpdated,
            updatedAt: store[ns].lastUpdated,
          }),
          { status: 200 },
        );
      }
      if (method === 'DELETE') {
        if (!store[ns]) {
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
          });
        }
        delete store[ns];
        return new Response(
          JSON.stringify({ success: true, message: `Namespace "${ns}" deleted` }),
          { status: 200 },
        );
      }
    }

    // Match namespaces list
    if (path === '/api/v1/state/namespaces' && method === 'GET') {
      const items = Object.entries(store).map(([name, data]) => ({
        namespaceId: `ns_${name}_test`,
        namespace: name,
        keyCount: Object.keys(data.entries).length,
        lastUpdated: data.lastUpdated,
        createdAt: data.lastUpdated,
        isOwned: true,
      }));
      return new Response(
        JSON.stringify({ namespaces: items, count: items.length }),
        { status: 200 },
      );
    }

    return new Response(
      JSON.stringify({ error: `Mock not implemented: ${method} ${path}` }),
      { status: 501 },
    );
  }) as unknown as typeof globalThis.fetch;
}

describe('global-state pack integration — registration + chained execution', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebappUrl: string | undefined;

  beforeAll(() => {
    // Re-register all six tools against the singleton. In production this is
    // done by `registerBuiltinTools` via require('./native/foo.js'), which
    // doesn't fire when running TS sources under vitest (no .js sibling).
    const registry = getNativeRegistry();
    if (!registry.has('get_global_state'))
      registry.register('get_global_state', getGlobalStateTool);
    if (!registry.has('set_global_state'))
      registry.register('set_global_state', setGlobalStateTool);
    if (!registry.has('delete_global_state'))
      registry.register('delete_global_state', deleteGlobalStateTool);
    if (!registry.has('list_global_state'))
      registry.register('list_global_state', listGlobalStateTool);
    if (!registry.has('list_namespaces'))
      registry.register('list_namespaces', listNamespacesTool);
    if (!registry.has('delete_namespace'))
      registry.register('delete_namespace', deleteNamespaceTool);
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebappUrl = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = WEBAPP;
    globalThis.fetch = createMockStateApi();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebappUrl === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = originalWebappUrl;
    vi.restoreAllMocks();
  });

  test('NativeToolRegistry has all 6 global-state tools registered', () => {
    const registry = getNativeRegistry();
    for (const name of [
      'get_global_state',
      'set_global_state',
      'delete_global_state',
      'list_global_state',
      'list_namespaces',
      'delete_namespace',
    ]) {
      expect(registry.has(name)).toBe(true);
    }

    const all = registry.listTools().map(t => t.name);
    expect(all).toEqual(
      expect.arrayContaining([
        'get_global_state',
        'set_global_state',
        'delete_global_state',
        'list_global_state',
        'list_namespaces',
        'delete_namespace',
      ]),
    );

    const set = registry.get('set_global_state')!;
    expect(set.server).toBe('state');
    expect(set.inputSchema.required).toEqual(
      expect.arrayContaining(['namespace', 'key', 'value']),
    );
  });

  test('end-to-end: set → list → get → delete cycle via registry.callTool', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();
    const ns = 'integration-prefs';

    // 1. set
    const setResult = await registry.callTool(
      'set_global_state',
      {
        namespace: ns,
        key: 'theme',
        value: 'dark',
        description: 'User theme preference',
      },
      ctx,
    );
    expect(setResult.isError).toBeFalsy();
    expect(JSON.parse(setResult.content[0].text)).toEqual({ ok: true });

    // 2. list — should contain the value just written
    const listResult = await registry.callTool(
      'list_global_state',
      { namespace: ns },
      ctx,
    );
    expect(listResult.isError).toBeFalsy();
    const listBody = JSON.parse(listResult.content[0].text);
    expect(listBody.values.theme).toBe('dark');

    // 3. get — exists: true with the right value
    const getResult = await registry.callTool(
      'get_global_state',
      { namespace: ns, key: 'theme' },
      ctx,
    );
    expect(getResult.isError).toBeFalsy();
    expect(JSON.parse(getResult.content[0].text)).toEqual({
      value: 'dark',
      exists: true,
    });

    // 4. delete — existed: true
    const delResult = await registry.callTool(
      'delete_global_state',
      { namespace: ns, key: 'theme' },
      ctx,
    );
    expect(delResult.isError).toBeFalsy();
    expect(JSON.parse(delResult.content[0].text)).toEqual({
      ok: true,
      existed: true,
    });

    // 5. get again — exists: false
    const getResult2 = await registry.callTool(
      'get_global_state',
      { namespace: ns, key: 'theme' },
      ctx,
    );
    expect(getResult2.isError).toBeFalsy();
    expect(JSON.parse(getResult2.content[0].text)).toEqual({
      value: null,
      exists: false,
    });

    // 6. delete again — idempotent (existed: false this time)
    const delResult2 = await registry.callTool(
      'delete_global_state',
      { namespace: ns, key: 'theme' },
      ctx,
    );
    expect(delResult2.isError).toBeFalsy();
    expect(JSON.parse(delResult2.content[0].text)).toEqual({
      ok: true,
      existed: false,
    });
  });

  test('end-to-end: list_namespaces sees newly-created namespaces', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    // Initially empty
    const before = await registry.callTool('list_namespaces', {}, ctx);
    expect(before.isError).toBeFalsy();
    expect(JSON.parse(before.content[0].text).namespaces).toEqual([]);

    // Create a namespace by writing a value into it
    await registry.callTool(
      'set_global_state',
      { namespace: 'cache', key: 'k1', value: 1 },
      ctx,
    );
    await registry.callTool(
      'set_global_state',
      { namespace: 'cache', key: 'k2', value: 2 },
      ctx,
    );
    await registry.callTool(
      'set_global_state',
      { namespace: 'prefs', key: 'theme', value: 'dark' },
      ctx,
    );

    const after = await registry.callTool('list_namespaces', {}, ctx);
    expect(after.isError).toBeFalsy();
    const body = JSON.parse(after.content[0].text);
    expect(body.namespaces).toHaveLength(2);

    const cache = body.namespaces.find((x: any) => x.name === 'cache');
    const prefs = body.namespaces.find((x: any) => x.name === 'prefs');
    expect(cache?.keyCount).toBe(2);
    expect(prefs?.keyCount).toBe(1);
    expect(cache?.lastModified).toBeDefined();
    expect(prefs?.lastModified).toBeDefined();
  });

  test('end-to-end: delete_namespace clears the namespace and reports the prior key count', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    // Seed three keys in a namespace
    for (const [k, v] of [['a', 1], ['b', 2], ['c', 3]] as [string, number][]) {
      await registry.callTool(
        'set_global_state',
        { namespace: 'doomed', key: k, value: v },
        ctx,
      );
    }

    // Sanity: list has 3 entries
    const list = await registry.callTool(
      'list_global_state',
      { namespace: 'doomed' },
      ctx,
    );
    expect(Object.keys(JSON.parse(list.content[0].text).values)).toHaveLength(3);

    // Delete the whole namespace
    const del = await registry.callTool(
      'delete_namespace',
      { namespace: 'doomed' },
      ctx,
    );
    expect(del.isError).toBeFalsy();
    expect(JSON.parse(del.content[0].text)).toEqual({
      ok: true,
      deletedKeys: 3,
    });

    // After delete: list returns empty
    const listAfter = await registry.callTool(
      'list_global_state',
      { namespace: 'doomed' },
      ctx,
    );
    expect(JSON.parse(listAfter.content[0].text).values).toEqual({});

    // After delete: get returns exists: false
    const get = await registry.callTool(
      'get_global_state',
      { namespace: 'doomed', key: 'a' },
      ctx,
    );
    expect(JSON.parse(get.content[0].text)).toEqual({
      value: null,
      exists: false,
    });

    // Re-deleting is idempotent
    const delAgain = await registry.callTool(
      'delete_namespace',
      { namespace: 'doomed' },
      ctx,
    );
    expect(delAgain.isError).toBeFalsy();
    expect(JSON.parse(delAgain.content[0].text)).toEqual({
      ok: true,
      deletedKeys: 0,
    });
  });

  test('end-to-end: chain handles upstream error gracefully without crashing', async () => {
    const registry = getNativeRegistry();
    // Override fetch to fail every call with 500
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const setResult = await registry.callTool(
      'set_global_state',
      { namespace: 'broken', key: 'k', value: 'v' },
      ctx,
    );
    expect(setResult.isError).toBe(true);
    const body = JSON.parse(setResult.content[0].text);
    expect(body.status).toBe(500);
  });
});
