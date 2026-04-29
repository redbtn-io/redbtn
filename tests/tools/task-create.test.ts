/**
 * Vitest for native tool: task_create
 *
 * Per ENVIRONMENT-HANDOFF.md §6 — happy path + validation + scope resolution
 * + upstream error.
 *
 * The handler talks to the webapp's /api/v1/state API via global `fetch`.
 * We mock fetch with an in-memory backing store so we can verify the
 * read-mutate-write semantics end-to-end.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import taskCreateTool from '../../src/lib/tools/native/task-create';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'run_test_' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

const WEBAPP = 'http://test-webapp.example';

/**
 * Mock fetch that maintains a per-namespace in-memory store of the
 * `tasks` envelope so we can chain reads/writes within a single test.
 */
function createMockApi(): typeof globalThis.fetch {
  const store: Record<string, unknown> = {}; // ns → value of `tasks` key

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : (input as URL).toString();
    const url = new URL(u);
    const method = (init?.method || 'GET').toUpperCase();
    const path = url.pathname;

    let m = path.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\/values\/([^/]+)$/);
    if (m && method === 'GET') {
      const ns = decodeURIComponent(m[1]);
      const key = decodeURIComponent(m[2]);
      if (key !== 'tasks' || store[ns] === undefined) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      return new Response(
        JSON.stringify({ key, value: store[ns] }),
        { status: 200 },
      );
    }

    m = path.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\/values$/);
    if (m && method === 'POST') {
      const ns = decodeURIComponent(m[1]);
      const body = JSON.parse(String(init?.body || '{}'));
      store[ns] = body.value;
      return new Response(
        JSON.stringify({ success: true, key: body.key, namespace: ns }),
        { status: 200 },
      );
    }

    return new Response(
      JSON.stringify({ error: `Unhandled mock route: ${method} ${path}` }),
      { status: 501 },
    );
  }) as unknown as typeof globalThis.fetch;
}

describe('task_create — schema', () => {
  test('exposes required subject + optional fields', () => {
    expect(taskCreateTool.description.toLowerCase()).toMatch(/task|todo/);
    expect(taskCreateTool.inputSchema.required).toEqual(['subject']);
    expect(taskCreateTool.inputSchema.properties.subject).toBeDefined();
    expect(taskCreateTool.inputSchema.properties.description).toBeDefined();
    expect(taskCreateTool.inputSchema.properties.parentTaskId).toBeDefined();
    expect(taskCreateTool.inputSchema.properties.metadata).toBeDefined();
    expect(taskCreateTool.inputSchema.properties.scope).toBeDefined();
    expect(taskCreateTool.inputSchema.properties.scope.enum).toEqual([
      'run',
      'conversation',
    ]);
    expect(taskCreateTool.server).toBe('task');
  });
});

describe('task_create — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebappUrl: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebappUrl = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = WEBAPP;
    globalThis.fetch = createMockApi();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebappUrl === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = originalWebappUrl;
    vi.restoreAllMocks();
  });

  test('returns valid taskId starting with task_ prefix', async () => {
    const ctx = makeMockContext({ runId: 'run-abc' });
    const result = await taskCreateTool.handler(
      { subject: 'Refactor router' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.taskId).toMatch(/^task_[A-Za-z0-9_-]{8}$/);
  });

  test('persists task to state with all fields', async () => {
    let lastWrite: { ns: string; body: any } | null = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      const url = new URL(u);
      const method = (init?.method || 'GET').toUpperCase();
      const path = url.pathname;
      const m = path.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\/values$/);
      if (m && method === 'POST') {
        lastWrite = {
          ns: decodeURIComponent(m[1]),
          body: JSON.parse(String(init?.body || '{}')),
        };
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      // GET → empty
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext({ runId: 'run-xyz' });
    const result = await taskCreateTool.handler(
      {
        subject: 'Test subject',
        description: 'Long description',
        metadata: { category: 'refactor' },
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const { taskId } = JSON.parse(result.content[0].text);

    expect(lastWrite).not.toBeNull();
    expect(lastWrite!.ns).toBe('agent-tasks:run-xyz');
    expect(lastWrite!.body.key).toBe('tasks');
    const stored = lastWrite!.body.value.tasks[0];
    expect(stored.taskId).toBe(taskId);
    expect(stored.subject).toBe('Test subject');
    expect(stored.description).toBe('Long description');
    expect(stored.metadata).toEqual({ category: 'refactor' });
    expect(stored.status).toBe('pending');
    expect(stored.createdAt).toMatch(/T.*Z$/);
    expect(stored.updatedAt).toBe(stored.createdAt);
    // Optional fields not present should be omitted
    expect('parentTaskId' in stored).toBe(false);
    expect('completedAt' in stored).toBe(false);
    expect('result' in stored).toBe(false);
  });

  test('appends to existing task list (read-mutate-write)', async () => {
    const ctx = makeMockContext({ runId: 'run-1' });

    // First create
    const r1 = await taskCreateTool.handler({ subject: 'Task 1' }, ctx);
    expect(r1.isError).toBeFalsy();
    const id1 = JSON.parse(r1.content[0].text).taskId;

    // Second create — should NOT clobber the first
    const r2 = await taskCreateTool.handler({ subject: 'Task 2' }, ctx);
    expect(r2.isError).toBeFalsy();
    const id2 = JSON.parse(r2.content[0].text).taskId;
    expect(id2).not.toBe(id1);

    // Verify directly via fetch — both should exist
    const verifyResp = await fetch(
      `${WEBAPP}/api/v1/state/namespaces/agent-tasks:run-1/values/tasks`,
    );
    const data = await verifyResp.json();
    expect(data.value.tasks).toHaveLength(2);
    expect(data.value.tasks[0].taskId).toBe(id1);
    expect(data.value.tasks[1].taskId).toBe(id2);
  });

  test('respects parentTaskId field', async () => {
    const ctx = makeMockContext({ runId: 'run-parent' });
    const r = await taskCreateTool.handler(
      {
        subject: 'Child task',
        parentTaskId: 'task_PARENTID',
      },
      ctx,
    );
    expect(r.isError).toBeFalsy();

    const verifyResp = await fetch(
      `${WEBAPP}/api/v1/state/namespaces/agent-tasks:run-parent/values/tasks`,
    );
    const data = await verifyResp.json();
    expect(data.value.tasks[0].parentTaskId).toBe('task_PARENTID');
  });

  test('scope=conversation uses conversationId from state', async () => {
    let observedNs: string | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      const url = new URL(u);
      const method = (init?.method || 'GET').toUpperCase();
      const m = url.pathname.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\//);
      if (m) observedNs = decodeURIComponent(m[1]);
      if (method === 'GET') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext({
      runId: 'run-aaa',
      state: { conversationId: 'conv-bbb' } as any,
    });
    const r = await taskCreateTool.handler(
      { subject: 'In conv', scope: 'conversation' },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(observedNs).toBe('agent-tasks:conv-bbb');
  });

  test('scope=run uses runId from context', async () => {
    let observedNs: string | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      const url = new URL(u);
      const method = (init?.method || 'GET').toUpperCase();
      const m = url.pathname.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\//);
      if (m) observedNs = decodeURIComponent(m[1]);
      if (method === 'GET') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext({ runId: 'run-explicit' });
    const r = await taskCreateTool.handler(
      { subject: 'In run', scope: 'run' },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(observedNs).toBe('agent-tasks:run-explicit');
  });

  test('default scope is run', async () => {
    let observedNs: string | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      const url = new URL(u);
      const method = (init?.method || 'GET').toUpperCase();
      const m = url.pathname.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\//);
      if (m) observedNs = decodeURIComponent(m[1]);
      if (method === 'GET') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext({
      runId: 'run-default',
      state: { conversationId: 'conv-default' } as any,
    });
    const r = await taskCreateTool.handler({ subject: 'Default' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(observedNs).toBe('agent-tasks:run-default');
  });

  test('reads runId from state.runId fallback', async () => {
    let observedNs: string | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      const url = new URL(u);
      const method = (init?.method || 'GET').toUpperCase();
      const m = url.pathname.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\//);
      if (m) observedNs = decodeURIComponent(m[1]);
      if (method === 'GET') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext({
      runId: null,
      state: { runId: 'state-run-id' } as any,
    });
    const r = await taskCreateTool.handler({ subject: 'Fallback' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(observedNs).toBe('agent-tasks:state-run-id');
  });
});

describe('task_create — validation errors', () => {
  test('missing subject returns isError + VALIDATION', async () => {
    // @ts-expect-error — runtime validation
    const r = await taskCreateTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/subject is required/i);
  });

  test('whitespace-only subject returns isError', async () => {
    const r = await taskCreateTool.handler(
      { subject: '   ' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('scope=run with no runId returns VALIDATION', async () => {
    const ctx = makeMockContext({ runId: null });
    const r = await taskCreateTool.handler({ subject: 'orphan' }, ctx);
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/no runId is available/i);
  });

  test('scope=conversation with no conversationId returns VALIDATION', async () => {
    const ctx = makeMockContext({ runId: 'run-x' });
    const r = await taskCreateTool.handler(
      { subject: 'orphan', scope: 'conversation' },
      ctx,
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/no conversationId is available/i);
  });
});

describe('task_create — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 on read surfaces error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await taskCreateTool.handler(
      { subject: 'x' },
      makeMockContext({ runId: 'run-fail' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('500 on write surfaces error', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      calls++;
      if (method === 'GET') {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      // POST → fail
      return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
    }) as unknown as typeof globalThis.fetch;

    const r = await taskCreateTool.handler(
      { subject: 'x' },
      makeMockContext({ runId: 'run-fail' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
    expect(calls).toBe(2); // GET + POST
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED state-api');
    }) as unknown as typeof globalThis.fetch;

    const r = await taskCreateTool.handler(
      { subject: 'x' },
      makeMockContext({ runId: 'run-fail' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });
});
