/**
 * Vitest for native tool: task_update
 *
 * Per ENVIRONMENT-HANDOFF.md §6 — happy path + validation + scope + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import taskUpdateTool from '../../src/lib/tools/native/task-update';
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

const baseSeed: AgentTask[] = [
  {
    taskId: 'task_aaa',
    subject: 'First task',
    status: 'pending',
    createdAt: '2026-04-27T10:00:00Z',
    updatedAt: '2026-04-27T10:00:00Z',
  },
];

/**
 * Returns mock fetch + the latest write capture.
 * Reads return the seed; writes are captured for assertion.
 */
function makeRWMock(initialSeed: AgentTask[]): {
  fetch: typeof globalThis.fetch;
  getLastWrite: () => { ns: string; tasks: AgentTask[] } | null;
} {
  let seed = initialSeed;
  let last: { ns: string; tasks: AgentTask[] } | null = null;

  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : (input as URL).toString();
    const url = new URL(u);
    const method = (init?.method || 'GET').toUpperCase();
    const path = url.pathname;

    let m = path.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\/values\/tasks$/);
    if (m && method === 'GET') {
      return new Response(
        JSON.stringify({ key: 'tasks', value: { tasks: seed } }),
        { status: 200 },
      );
    }
    m = path.match(/^\/api\/v1\/state\/namespaces\/([^/]+)\/values$/);
    if (m && method === 'POST') {
      const body = JSON.parse(String(init?.body || '{}'));
      last = {
        ns: decodeURIComponent(m[1]),
        tasks: body.value.tasks,
      };
      seed = body.value.tasks; // persist for subsequent reads in same test
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'Unhandled' }), { status: 501 });
  }) as unknown as typeof globalThis.fetch;

  return { fetch: f, getLastWrite: () => last };
}

describe('task_update — schema', () => {
  test('exposes taskId required + optional mutable fields', () => {
    expect(taskUpdateTool.inputSchema.required).toEqual(['taskId']);
    expect(taskUpdateTool.inputSchema.properties.taskId).toBeDefined();
    expect(taskUpdateTool.inputSchema.properties.status).toBeDefined();
    expect(taskUpdateTool.inputSchema.properties.subject).toBeDefined();
    expect(taskUpdateTool.inputSchema.properties.description).toBeDefined();
    expect(taskUpdateTool.inputSchema.properties.scope).toBeDefined();
    expect(taskUpdateTool.server).toBe('task');
  });
});

describe('task_update — happy path', () => {
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

  test('updates status field', async () => {
    const { fetch, getLastWrite } = makeRWMock(baseSeed);
    globalThis.fetch = fetch;

    const r = await taskUpdateTool.handler(
      { taskId: 'task_aaa', status: 'in_progress' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true });

    const last = getLastWrite();
    expect(last).not.toBeNull();
    expect(last!.tasks[0].status).toBe('in_progress');
    expect(last!.tasks[0].subject).toBe('First task'); // unchanged
    // updatedAt should be bumped
    expect(last!.tasks[0].updatedAt).not.toBe(baseSeed[0].updatedAt);
  });

  test('updates subject field', async () => {
    const { fetch, getLastWrite } = makeRWMock(baseSeed);
    globalThis.fetch = fetch;

    const r = await taskUpdateTool.handler(
      { taskId: 'task_aaa', subject: 'Renamed task' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    const last = getLastWrite()!;
    expect(last.tasks[0].subject).toBe('Renamed task');
    expect(last.tasks[0].status).toBe('pending'); // unchanged
  });

  test('updates description field', async () => {
    const { fetch, getLastWrite } = makeRWMock(baseSeed);
    globalThis.fetch = fetch;

    const r = await taskUpdateTool.handler(
      { taskId: 'task_aaa', description: 'New long-form notes' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    const last = getLastWrite()!;
    expect(last.tasks[0].description).toBe('New long-form notes');
  });

  test('updates multiple fields atomically in one call', async () => {
    const { fetch, getLastWrite } = makeRWMock(baseSeed);
    globalThis.fetch = fetch;

    const r = await taskUpdateTool.handler(
      {
        taskId: 'task_aaa',
        status: 'in_progress',
        subject: 'Renamed',
        description: 'New notes',
      },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    const last = getLastWrite()!;
    expect(last.tasks[0].status).toBe('in_progress');
    expect(last.tasks[0].subject).toBe('Renamed');
    expect(last.tasks[0].description).toBe('New notes');
  });

  test('does not affect sibling tasks', async () => {
    const seed: AgentTask[] = [
      ...baseSeed,
      {
        taskId: 'task_bbb',
        subject: 'Sibling',
        status: 'in_progress',
        createdAt: '2026-04-27T10:30:00Z',
        updatedAt: '2026-04-27T10:30:00Z',
      },
    ];
    const { fetch, getLastWrite } = makeRWMock(seed);
    globalThis.fetch = fetch;

    const r = await taskUpdateTool.handler(
      { taskId: 'task_aaa', status: 'completed' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    const last = getLastWrite()!;
    expect(last.tasks).toHaveLength(2);
    const updated = last.tasks.find(t => t.taskId === 'task_aaa')!;
    const sibling = last.tasks.find(t => t.taskId === 'task_bbb')!;
    expect(updated.status).toBe('completed');
    expect(sibling.status).toBe('in_progress');
    expect(sibling.updatedAt).toBe('2026-04-27T10:30:00Z');
  });
});

describe('task_update — error cases', () => {
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

  test('missing taskId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await taskUpdateTool.handler({}, makeMockContext({ runId: 'r' }));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('no mutable field returns VALIDATION', async () => {
    const r = await taskUpdateTool.handler(
      { taskId: 'task_aaa' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/at least one/i);
  });

  test('invalid status returns VALIDATION', async () => {
    const r = await taskUpdateTool.handler(
      { taskId: 'task_aaa', status: 'bogus' as any },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('unknown taskId returns NOT_FOUND', async () => {
    const { fetch } = makeRWMock(baseSeed);
    globalThis.fetch = fetch;

    const r = await taskUpdateTool.handler(
      { taskId: 'task_does_not_exist', status: 'completed' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('NOT_FOUND');
    expect(body.error).toMatch(/task_does_not_exist/);
  });

  test('500 on read surfaces error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await taskUpdateTool.handler(
      { taskId: 'task_aaa', status: 'completed' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
