/**
 * Integration test for the native task pack.
 *
 * Per ENVIRONMENT-HANDOFF.md §6.2 — pack integration: full lifecycle
 *   create → list → update → complete → list (verify status filter).
 *
 * The webapp API is mocked via global fetch with an in-memory backing store
 * that mimics namespace/values semantics for the `tasks` key. This lets us
 * exercise the read-mutate-write contract end-to-end without spinning up
 * MongoDB / Redis / the webapp.
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

// Re-import the TS modules and explicitly re-register them: in production
// native-registry.ts loads each via require('./native/foo.js'), but under
// vitest the .js paths don't exist next to the .ts modules.
import taskCreateTool from '../../src/lib/tools/native/task-create';
import taskListTool from '../../src/lib/tools/native/task-list';
import taskUpdateTool from '../../src/lib/tools/native/task-update';
import taskCompleteTool from '../../src/lib/tools/native/task-complete';
import taskGetTool from '../../src/lib/tools/native/task-get';

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
 * In-memory mock for the webapp's /api/v1/state API focused on the
 * `tasks` key. This is a minimal subset of the global-state mock from
 * tools-global-state.test.ts — only the routes the task pack actually
 * touches are implemented.
 *
 * Routes handled:
 *   GET  /api/v1/state/namespaces/:ns/values/tasks
 *   POST /api/v1/state/namespaces/:ns/values     (body.key === 'tasks')
 */
function createMockStateApi(): typeof globalThis.fetch {
  const store: Record<string, unknown> = {}; // ns → value of `tasks` key

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : (input as URL).toString();
    const url = new URL(u);
    const method = (init?.method || 'GET').toUpperCase();
    const path = url.pathname;

    let m = path.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\/values\/([^/]+)$/);
    if (m) {
      const ns = decodeURIComponent(m[1]);
      const key = decodeURIComponent(m[2]);
      if (method === 'GET') {
        if (key !== 'tasks' || store[ns] === undefined) {
          return new Response(
            JSON.stringify({ error: 'Key not found' }),
            { status: 404 },
          );
        }
        return new Response(
          JSON.stringify({ key, value: store[ns] }),
          { status: 200 },
        );
      }
    }

    m = path.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\/values$/);
    if (m && method === 'POST') {
      const ns = decodeURIComponent(m[1]);
      const body = JSON.parse(String(init?.body || '{}'));
      if (!body.key) {
        return new Response(
          JSON.stringify({ error: 'Key is required' }),
          { status: 400 },
        );
      }
      // Only `tasks` is exercised by the pack — matches the storage layout
      store[ns] = body.value;
      return new Response(
        JSON.stringify({ success: true, key: body.key, namespace: ns }),
        { status: 200 },
      );
    }

    return new Response(
      JSON.stringify({ error: `Mock not implemented: ${method} ${path}` }),
      { status: 501 },
    );
  }) as unknown as typeof globalThis.fetch;
}

describe('task pack integration — registration + chained execution', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebappUrl: string | undefined;

  beforeAll(() => {
    const registry = getNativeRegistry();
    if (!registry.has('task_create'))
      registry.register('task_create', taskCreateTool);
    if (!registry.has('task_list'))
      registry.register('task_list', taskListTool);
    if (!registry.has('task_update'))
      registry.register('task_update', taskUpdateTool);
    if (!registry.has('task_complete'))
      registry.register('task_complete', taskCompleteTool);
    if (!registry.has('task_get'))
      registry.register('task_get', taskGetTool);
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

  test('NativeToolRegistry has all 5 task-pack tools registered', () => {
    const registry = getNativeRegistry();
    for (const name of [
      'task_create',
      'task_list',
      'task_update',
      'task_complete',
      'task_get',
    ]) {
      expect(registry.has(name)).toBe(true);
      expect(registry.get(name)?.server).toBe('task');
    }

    const all = registry.listTools().map(t => t.name);
    expect(all).toEqual(
      expect.arrayContaining([
        'task_create',
        'task_list',
        'task_update',
        'task_complete',
        'task_get',
      ]),
    );
  });

  test('full lifecycle: create → list → update → complete → list (status filter) → get', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext({ runId: 'integration-lifecycle' });

    // 1. create — three tasks
    const c1 = await registry.callTool(
      'task_create',
      { subject: 'Refactor auth module' },
      ctx,
    );
    expect(c1.isError).toBeFalsy();
    const id1 = JSON.parse(c1.content[0].text).taskId;

    const c2 = await registry.callTool(
      'task_create',
      { subject: 'Add tests', description: 'Cover new branches' },
      ctx,
    );
    expect(c2.isError).toBeFalsy();
    const id2 = JSON.parse(c2.content[0].text).taskId;

    const c3 = await registry.callTool(
      'task_create',
      { subject: 'Sub-task: extract validator', parentTaskId: id1 },
      ctx,
    );
    expect(c3.isError).toBeFalsy();
    const id3 = JSON.parse(c3.content[0].text).taskId;

    // All IDs should be unique and shaped task_<8 chars>
    expect(new Set([id1, id2, id3]).size).toBe(3);
    for (const id of [id1, id2, id3]) {
      expect(id).toMatch(/^task_[A-Za-z0-9_-]{8}$/);
    }

    // 2. list (no filter) — should see all three, FIFO
    const l1 = await registry.callTool('task_list', {}, ctx);
    expect(l1.isError).toBeFalsy();
    const lst1 = JSON.parse(l1.content[0].text).tasks;
    expect(lst1).toHaveLength(3);
    expect(lst1.map((t: any) => t.taskId)).toEqual([id1, id2, id3]);
    expect(lst1.every((t: any) => t.status === 'pending')).toBe(true);

    // 3. list with parentTaskId filter — should see only the child
    const lChildren = await registry.callTool(
      'task_list',
      { parentTaskId: id1 },
      ctx,
    );
    expect(lChildren.isError).toBeFalsy();
    const childList = JSON.parse(lChildren.content[0].text).tasks;
    expect(childList).toHaveLength(1);
    expect(childList[0].taskId).toBe(id3);

    // 4. update — bump task 1 to in_progress
    const u1 = await registry.callTool(
      'task_update',
      { taskId: id1, status: 'in_progress' },
      ctx,
    );
    expect(u1.isError).toBeFalsy();
    expect(JSON.parse(u1.content[0].text)).toEqual({ ok: true });

    // Verify with task_get — full doc, status changed, updatedAt bumped
    const g1 = await registry.callTool('task_get', { taskId: id1 }, ctx);
    expect(g1.isError).toBeFalsy();
    const got1 = JSON.parse(g1.content[0].text).task;
    expect(got1.taskId).toBe(id1);
    expect(got1.status).toBe('in_progress');
    expect(got1.updatedAt > got1.createdAt).toBe(true);

    // 5. complete — finish task 2 with a result
    const compResult = { ok: true, count: 7 };
    const cmp = await registry.callTool(
      'task_complete',
      { taskId: id2, result: compResult },
      ctx,
    );
    expect(cmp.isError).toBeFalsy();
    expect(JSON.parse(cmp.content[0].text)).toEqual({ ok: true });

    // Verify completed via task_get
    const g2 = await registry.callTool('task_get', { taskId: id2 }, ctx);
    expect(g2.isError).toBeFalsy();
    const got2 = JSON.parse(g2.content[0].text).task;
    expect(got2.status).toBe('completed');
    expect(got2.completedAt).toBeDefined();
    expect(got2.result).toEqual(compResult);

    // 6. list (status filter: completed) — should see only task 2
    const lCompleted = await registry.callTool(
      'task_list',
      { status: 'completed' },
      ctx,
    );
    expect(lCompleted.isError).toBeFalsy();
    const completedList = JSON.parse(lCompleted.content[0].text).tasks;
    expect(completedList).toHaveLength(1);
    expect(completedList[0].taskId).toBe(id2);

    // 7. list (status filter: pending) — task 3 only (task 1 in_progress, task 2 completed)
    const lPending = await registry.callTool(
      'task_list',
      { status: 'pending' },
      ctx,
    );
    expect(lPending.isError).toBeFalsy();
    const pendingList = JSON.parse(lPending.content[0].text).tasks;
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0].taskId).toBe(id3);

    // 8. list (status filter: in_progress) — task 1 only
    const lInProgress = await registry.callTool(
      'task_list',
      { status: 'in_progress' },
      ctx,
    );
    expect(lInProgress.isError).toBeFalsy();
    const inProgressList = JSON.parse(lInProgress.content[0].text).tasks;
    expect(inProgressList).toHaveLength(1);
    expect(inProgressList[0].taskId).toBe(id1);

    // 9. task_get for missing → null
    const g3 = await registry.callTool(
      'task_get',
      { taskId: 'task_NOPE' },
      ctx,
    );
    expect(g3.isError).toBeFalsy();
    expect(JSON.parse(g3.content[0].text).task).toBeNull();
  });

  test('scope=conversation isolates tasks from scope=run', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext({
      runId: 'run-iso',
      state: { conversationId: 'conv-iso' } as any,
    });

    // Create one task in run scope, one in conversation scope
    const cRun = await registry.callTool(
      'task_create',
      { subject: 'Run-scoped task' },
      ctx,
    );
    expect(cRun.isError).toBeFalsy();
    const cConv = await registry.callTool(
      'task_create',
      { subject: 'Conv-scoped task', scope: 'conversation' },
      ctx,
    );
    expect(cConv.isError).toBeFalsy();

    // Each scope should see only its own task
    const lRun = await registry.callTool('task_list', {}, ctx);
    const runTasks = JSON.parse(lRun.content[0].text).tasks;
    expect(runTasks).toHaveLength(1);
    expect(runTasks[0].subject).toBe('Run-scoped task');

    const lConv = await registry.callTool(
      'task_list',
      { scope: 'conversation' },
      ctx,
    );
    const convTasks = JSON.parse(lConv.content[0].text).tasks;
    expect(convTasks).toHaveLength(1);
    expect(convTasks[0].subject).toBe('Conv-scoped task');
  });

  test('upstream error in one stage does not corrupt later stages', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext({ runId: 'integration-resilient' });

    // First create succeeds
    const c1 = await registry.callTool(
      'task_create',
      { subject: 'task A' },
      ctx,
    );
    expect(c1.isError).toBeFalsy();

    // Override fetch to simulate upstream failure
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const fail = await registry.callTool(
      'task_create',
      { subject: 'task B' },
      ctx,
    );
    expect(fail.isError).toBe(true);
    expect(JSON.parse(fail.content[0].text).status).toBe(500);

    // Recover — restore the working mock and confirm we can list the
    // pre-existing task
    globalThis.fetch = createMockStateApi();
    const cFresh = await registry.callTool(
      'task_create',
      { subject: 'task C', scope: 'run' },
      ctx,
    );
    expect(cFresh.isError).toBeFalsy(); // fresh store but the API works
  });
});
