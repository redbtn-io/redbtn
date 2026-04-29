/**
 * Vitest for native tool: task_complete
 *
 * Per ENVIRONMENT-HANDOFF.md §6 — happy path + scope + result + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import taskCompleteTool from '../../src/lib/tools/native/task-complete';
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
    taskId: 'task_done',
    subject: 'A task to finish',
    status: 'in_progress',
    createdAt: '2026-04-27T10:00:00Z',
    updatedAt: '2026-04-27T10:30:00Z',
  },
];

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
      seed = body.value.tasks;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'Unhandled' }), { status: 501 });
  }) as unknown as typeof globalThis.fetch;

  return { fetch: f, getLastWrite: () => last };
}

describe('task_complete — schema', () => {
  test('exposes taskId required, optional result and scope', () => {
    expect(taskCompleteTool.inputSchema.required).toEqual(['taskId']);
    expect(taskCompleteTool.inputSchema.properties.taskId).toBeDefined();
    expect(taskCompleteTool.inputSchema.properties.result).toBeDefined();
    expect(taskCompleteTool.inputSchema.properties.scope).toBeDefined();
    expect(taskCompleteTool.server).toBe('task');
  });
});

describe('task_complete — happy path', () => {
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

  test('sets status=completed and stamps completedAt', async () => {
    const { fetch, getLastWrite } = makeRWMock(baseSeed);
    globalThis.fetch = fetch;

    const r = await taskCompleteTool.handler(
      { taskId: 'task_done' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true });

    const last = getLastWrite();
    expect(last).not.toBeNull();
    const t = last!.tasks[0];
    expect(t.status).toBe('completed');
    expect(t.completedAt).toBeDefined();
    expect(t.completedAt).toMatch(/T.*Z$/);
    expect(t.updatedAt).toBe(t.completedAt);
  });

  test('stores arbitrary result payload', async () => {
    const { fetch, getLastWrite } = makeRWMock(baseSeed);
    globalThis.fetch = fetch;

    const result = { score: 95, flagged: ['a', 'b'], note: 'all good' };
    const r = await taskCompleteTool.handler(
      { taskId: 'task_done', result },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();

    const last = getLastWrite()!;
    expect(last.tasks[0].result).toEqual(result);
  });

  test('result=null is valid', async () => {
    const { fetch, getLastWrite } = makeRWMock(baseSeed);
    globalThis.fetch = fetch;
    const r = await taskCompleteTool.handler(
      { taskId: 'task_done', result: null },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    expect(getLastWrite()!.tasks[0].result).toBeNull();
  });

  test('result=string is valid', async () => {
    const { fetch, getLastWrite } = makeRWMock(baseSeed);
    globalThis.fetch = fetch;
    const r = await taskCompleteTool.handler(
      { taskId: 'task_done', result: 'plain string' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    expect(getLastWrite()!.tasks[0].result).toBe('plain string');
  });

  test('preserves other task fields', async () => {
    const seed: AgentTask[] = [
      {
        taskId: 'task_done',
        subject: 'A task',
        description: 'Some details',
        status: 'in_progress',
        parentTaskId: 'task_parent',
        metadata: { x: 1 },
        createdAt: '2026-04-27T09:00:00Z',
        updatedAt: '2026-04-27T09:30:00Z',
      },
    ];
    const { fetch, getLastWrite } = makeRWMock(seed);
    globalThis.fetch = fetch;

    const r = await taskCompleteTool.handler(
      { taskId: 'task_done' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBeFalsy();
    const t = getLastWrite()!.tasks[0];
    expect(t.subject).toBe('A task');
    expect(t.description).toBe('Some details');
    expect(t.parentTaskId).toBe('task_parent');
    expect(t.metadata).toEqual({ x: 1 });
    expect(t.createdAt).toBe('2026-04-27T09:00:00Z');
  });
});

describe('task_complete — error cases', () => {
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
    const r = await taskCompleteTool.handler({}, makeMockContext({ runId: 'r' }));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('unknown taskId returns NOT_FOUND', async () => {
    const { fetch } = makeRWMock(baseSeed);
    globalThis.fetch = fetch;

    const r = await taskCompleteTool.handler(
      { taskId: 'task_missing' },
      makeMockContext({ runId: 'run-1' }),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('NOT_FOUND');
  });

  test('500 surfaces error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await taskCompleteTool.handler(
      { taskId: 'task_done' },
      makeMockContext({ runId: 'r' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
