/**
 * Vitest for native tool: task_list
 *
 * Per ENVIRONMENT-HANDOFF.md §6 — happy path + filters + scope + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import taskListTool from '../../src/lib/tools/native/task-list';
import type { AgentTask } from '../../src/lib/tools/native/_task-helpers';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'run-test-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

const WEBAPP = 'http://test-webapp.example';

/**
 * Mock fetch that returns the given seed of tasks for any GET on the
 * `tasks` key under any namespace. POSTs are no-ops returning success.
 */
function mockApiWithSeed(seed: AgentTask[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : (input as URL).toString();
    const url = new URL(u);
    const method = (init?.method || 'GET').toUpperCase();
    const path = url.pathname;
    const m = path.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\/values\/tasks$/);
    if (m && method === 'GET') {
      return new Response(
        JSON.stringify({ key: 'tasks', value: { tasks: seed } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: `Unhandled` }), { status: 501 });
  }) as unknown as typeof globalThis.fetch;
}

describe('task_list — schema', () => {
  test('exposes optional filters', () => {
    expect(taskListTool.inputSchema.required).toEqual([]);
    expect(taskListTool.inputSchema.properties.status).toBeDefined();
    expect(taskListTool.inputSchema.properties.parentTaskId).toBeDefined();
    expect(taskListTool.inputSchema.properties.limit).toBeDefined();
    expect(taskListTool.inputSchema.properties.scope).toBeDefined();
    expect(taskListTool.inputSchema.properties.status.enum).toEqual([
      'pending',
      'in_progress',
      'completed',
      'cancelled',
    ]);
    expect(taskListTool.server).toBe('task');
  });
});

describe('task_list — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebappUrl: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebappUrl = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = WEBAPP;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebappUrl === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = originalWebappUrl;
    vi.restoreAllMocks();
  });

  const sampleTasks: AgentTask[] = [
    {
      taskId: 'task_1',
      subject: 'First',
      status: 'pending',
      createdAt: '2026-04-27T10:00:00Z',
      updatedAt: '2026-04-27T10:00:00Z',
    },
    {
      taskId: 'task_2',
      subject: 'Second',
      status: 'in_progress',
      createdAt: '2026-04-27T11:00:00Z',
      updatedAt: '2026-04-27T11:00:00Z',
    },
    {
      taskId: 'task_3',
      subject: 'Child',
      status: 'completed',
      parentTaskId: 'task_1',
      createdAt: '2026-04-27T12:00:00Z',
      updatedAt: '2026-04-27T12:00:00Z',
      completedAt: '2026-04-27T12:30:00Z',
    },
    {
      taskId: 'task_4',
      subject: 'Cancelled',
      status: 'cancelled',
      createdAt: '2026-04-27T13:00:00Z',
      updatedAt: '2026-04-27T13:00:00Z',
    },
  ];

  test('returns all tasks sorted FIFO by createdAt when no filter', async () => {
    globalThis.fetch = mockApiWithSeed(sampleTasks);
    const r = await taskListTool.handler({}, makeMockContext({ runId: 'run-1' }));
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.tasks).toHaveLength(4);
    expect(body.tasks.map((t: AgentTask) => t.taskId)).toEqual([
      'task_1',
      'task_2',
      'task_3',
      'task_4',
    ]);
  });

  test('filters by status', async () => {
    globalThis.fetch = mockApiWithSeed(sampleTasks);
    const r = await taskListTool.handler(
      { status: 'in_progress' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].taskId).toBe('task_2');
  });

  test('filters by completed status', async () => {
    globalThis.fetch = mockApiWithSeed(sampleTasks);
    const r = await taskListTool.handler(
      { status: 'completed' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].taskId).toBe('task_3');
  });

  test('filters by parentTaskId', async () => {
    globalThis.fetch = mockApiWithSeed(sampleTasks);
    const r = await taskListTool.handler(
      { parentTaskId: 'task_1' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].taskId).toBe('task_3');
  });

  test('combines status and parentTaskId filters', async () => {
    globalThis.fetch = mockApiWithSeed(sampleTasks);
    const r = await taskListTool.handler(
      { status: 'completed', parentTaskId: 'task_1' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].taskId).toBe('task_3');
  });

  test('respects limit', async () => {
    globalThis.fetch = mockApiWithSeed(sampleTasks);
    const r = await taskListTool.handler(
      { limit: 2 },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.tasks).toHaveLength(2);
    // Sorted FIFO so first two should be task_1 and task_2
    expect(body.tasks[0].taskId).toBe('task_1');
    expect(body.tasks[1].taskId).toBe('task_2');
  });

  test('returns empty list on 404 (no tasks created yet)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    const r = await taskListTool.handler({}, makeMockContext({ runId: 'run-empty' }));
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.tasks).toEqual([]);
  });

  test('returns empty list when value envelope is malformed', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ key: 'tasks', value: { not_tasks: 'oops' } }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;
    const r = await taskListTool.handler({}, makeMockContext({ runId: 'run-bad' }));
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).tasks).toEqual([]);
  });

  test('honours scope=conversation namespace', async () => {
    let observedNs: string | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      const m = new URL(u).pathname.match(
        /^\/api\/v1\/state\/namespaces\/([^/]+)\//,
      );
      if (m) observedNs = decodeURIComponent(m[1]);
      return new Response(
        JSON.stringify({ key: 'tasks', value: { tasks: [] } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext({
      runId: 'run-yyy',
      state: { conversationId: 'conv-zzz' } as any,
    });
    await taskListTool.handler({ scope: 'conversation' }, ctx);
    expect(observedNs).toBe('agent-tasks:conv-zzz');
  });
});

describe('task_list — validation errors', () => {
  test('invalid status returns VALIDATION', async () => {
    const r = await taskListTool.handler(
      { status: 'bogus' as any },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('non-integer limit returns VALIDATION', async () => {
    const r = await taskListTool.handler(
      { limit: 1.5 },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('zero limit returns VALIDATION', async () => {
    const r = await taskListTool.handler(
      { limit: 0 },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('scope=run with no runId returns VALIDATION', async () => {
    const r = await taskListTool.handler({}, makeMockContext({ runId: null }));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('scope=conversation with no conversationId returns VALIDATION', async () => {
    const r = await taskListTool.handler(
      { scope: 'conversation' },
      makeMockContext({ runId: 'run-x' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('task_list — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 surfaces error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await taskListTool.handler({}, makeMockContext({ runId: 'run-fail' }));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
