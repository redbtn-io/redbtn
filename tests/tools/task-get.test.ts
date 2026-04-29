/**
 * Vitest for native tool: task_get
 *
 * Per ENVIRONMENT-HANDOFF.md §6 — happy path + null on missing + scope + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import taskGetTool from '../../src/lib/tools/native/task-get';
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

const sampleTasks: AgentTask[] = [
  {
    taskId: 'task_aaa',
    subject: 'A task',
    description: 'Notes',
    status: 'in_progress',
    parentTaskId: 'task_parent',
    metadata: { tag: 'demo' },
    createdAt: '2026-04-27T10:00:00Z',
    updatedAt: '2026-04-27T11:00:00Z',
  },
  {
    taskId: 'task_bbb',
    subject: 'Done thing',
    status: 'completed',
    result: { code: 0 },
    createdAt: '2026-04-27T12:00:00Z',
    updatedAt: '2026-04-27T12:30:00Z',
    completedAt: '2026-04-27T12:30:00Z',
  },
];

function mockSeededFetch(seed: AgentTask[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : (input as URL).toString();
    const url = new URL(u);
    const method = (init?.method || 'GET').toUpperCase();
    const m = url.pathname.match(
      /^\/api\/v1\/state\/namespaces\/([^/]+)\/values\/tasks$/,
    );
    if (m && method === 'GET') {
      return new Response(
        JSON.stringify({ key: 'tasks', value: { tasks: seed } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: 'Unhandled' }), { status: 501 });
  }) as unknown as typeof globalThis.fetch;
}

describe('task_get — schema', () => {
  test('exposes taskId required + scope optional', () => {
    expect(taskGetTool.inputSchema.required).toEqual(['taskId']);
    expect(taskGetTool.inputSchema.properties.taskId).toBeDefined();
    expect(taskGetTool.inputSchema.properties.scope).toBeDefined();
    expect(taskGetTool.server).toBe('task');
  });
});

describe('task_get — happy path', () => {
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

  test('returns full task doc when found', async () => {
    globalThis.fetch = mockSeededFetch(sampleTasks);
    const r = await taskGetTool.handler(
      { taskId: 'task_aaa' },
      makeMockContext({ runId: 'r' }),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.task).toEqual(sampleTasks[0]);
  });

  test('preserves all task fields including result + completedAt', async () => {
    globalThis.fetch = mockSeededFetch(sampleTasks);
    const r = await taskGetTool.handler(
      { taskId: 'task_bbb' },
      makeMockContext({ runId: 'r' }),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.task.taskId).toBe('task_bbb');
    expect(body.task.status).toBe('completed');
    expect(body.task.result).toEqual({ code: 0 });
    expect(body.task.completedAt).toBe('2026-04-27T12:30:00Z');
  });

  test('returns task: null when not found', async () => {
    globalThis.fetch = mockSeededFetch(sampleTasks);
    const r = await taskGetTool.handler(
      { taskId: 'task_missing' },
      makeMockContext({ runId: 'r' }),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.task).toBeNull();
  });

  test('returns task: null when namespace is empty (404 from API)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await taskGetTool.handler(
      { taskId: 'task_aaa' },
      makeMockContext({ runId: 'r' }),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).task).toBeNull();
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
        JSON.stringify({ key: 'tasks', value: { tasks: sampleTasks } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext({
      runId: 'r1',
      state: { conversationId: 'conv-99' } as any,
    });
    await taskGetTool.handler(
      { taskId: 'task_aaa', scope: 'conversation' },
      ctx,
    );
    expect(observedNs).toBe('agent-tasks:conv-99');
  });
});

describe('task_get — validation errors', () => {
  test('missing taskId returns VALIDATION', async () => {
    // @ts-expect-error
    const r = await taskGetTool.handler({}, makeMockContext({ runId: 'r' }));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('whitespace taskId returns VALIDATION', async () => {
    const r = await taskGetTool.handler(
      { taskId: '   ' },
      makeMockContext({ runId: 'r' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('scope=run with no runId returns VALIDATION', async () => {
    const r = await taskGetTool.handler(
      { taskId: 'task_aaa' },
      makeMockContext({ runId: null }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('scope=conversation with no conversationId returns VALIDATION', async () => {
    const r = await taskGetTool.handler(
      { taskId: 'task_aaa', scope: 'conversation' },
      makeMockContext({ runId: 'r' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('task_get — upstream error', () => {
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

    const r = await taskGetTool.handler(
      { taskId: 'task_aaa' },
      makeMockContext({ runId: 'r' }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
