/**
 * Vitest for native tool: update_automation
 *
 * Covers: schema, validation, forbidden-field rejection, cron re-validation,
 * enum validation, happy-path PATCH, and upstream-error handling.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import updateAutomationTool from '../../src/lib/tools/native/update-automation';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1' },
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('update_automation — schema', () => {
  test('requires automationId only', () => {
    expect(updateAutomationTool.description.toLowerCase()).toContain('patch');
    expect(updateAutomationTool.inputSchema.required).toEqual(['automationId']);
    expect(updateAutomationTool.inputSchema.properties.automationId).toBeDefined();
  });

  test('exposes the patchable fields in the schema', () => {
    const props = updateAutomationTool.inputSchema.properties;
    for (const f of [
      'triggers',
      'scheduleMode',
      'concurrency',
      'defaultInput',
      'inputMapping',
      'configOverrides',
      'name',
      'description',
      'tags',
    ]) {
      expect(props[f]).toBeDefined();
    }
  });

  test('does NOT expose graphId / userId as patchable', () => {
    const props = updateAutomationTool.inputSchema.properties;
    expect(props.graphId).toBeUndefined();
    expect(props.userId).toBeUndefined();
  });

  test('server label is automation', () => {
    expect(updateAutomationTool.server).toBe('automation');
  });
});

describe('update_automation — validation', () => {
  test('missing automationId returns isError + VALIDATION', async () => {
    const r = await updateAutomationTool.handler(
      { scheduleMode: 'cron' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('empty automationId returns isError', async () => {
    const r = await updateAutomationTool.handler(
      { automationId: '   ', name: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
  });

  test('no patchable field returns isError + VALIDATION', async () => {
    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('invalid scheduleMode rejected', async () => {
    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', scheduleMode: 'hourly' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('invalid concurrency rejected', async () => {
    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', concurrency: 'parallel' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('update_automation — forbidden fields', () => {
  test('patching graphId is rejected with FORBIDDEN_FIELD', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;

    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', graphId: 'other-graph', name: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('FORBIDDEN_FIELD');
    expect(body.forbiddenFields).toContain('graphId');
    // No request should ever be issued for a forbidden patch.
    expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test('patching userId is rejected', async () => {
    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', userId: 'someone-else' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('FORBIDDEN_FIELD');
  });

  test('patching streamId is rejected', async () => {
    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', streamId: 'strm_1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('FORBIDDEN_FIELD');
  });
});

describe('update_automation — cron re-validation', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('invalid cron expression is rejected with INVALID_CRON', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;

    const r = await updateAutomationTool.handler(
      {
        automationId: 'auto_x',
        triggers: [{ type: 'schedule', config: { cron: 'not a cron' } }],
      },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('INVALID_CRON');
    expect(body.error).toMatch(/cron/i);
    expect(spy).not.toHaveBeenCalled();
  });

  test('out-of-range cron field is rejected', async () => {
    const r = await updateAutomationTool.handler(
      {
        automationId: 'auto_x',
        triggers: [{ type: 'schedule', config: { cron: '99 * * * *' } }],
      },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('INVALID_CRON');
  });

  test('valid cron expression passes validation and issues the PATCH', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? '';
      return new Response(JSON.stringify({ success: true, automation: {} }), {
        status: 200,
      });
    }) as unknown as typeof globalThis.fetch;

    const r = await updateAutomationTool.handler(
      {
        automationId: 'auto_x',
        triggers: [{ type: 'schedule', config: { cron: '0 9 * * 1-5' } }],
      },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(capturedBody).triggers[0].config.cron).toBe('0 9 * * 1-5');
  });

  test('non-schedule triggers without cron pass through', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, automation: {} }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await updateAutomationTool.handler(
      {
        automationId: 'auto_x',
        triggers: [{ type: 'webhook', config: {} }],
      },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
  });

  test('triggers must be an array', async () => {
    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', triggers: { type: 'schedule' } as unknown as unknown[] },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('INVALID_CRON');
  });
});

describe('update_automation — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('PATCHes /api/v1/automations/:id with only supplied fields', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      capturedMethod = init?.method ?? 'GET';
      capturedBody = (init?.body as string) ?? '';
      return new Response(
        JSON.stringify({
          success: true,
          automation: { automationId: 'auto_x', concurrency: 'queue' },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', concurrency: 'queue', defaultInput: { foo: 'bar' } },
      makeMockContext(),
    );

    expect(capturedUrl).toContain('/api/v1/automations/auto_x');
    expect(capturedMethod).toBe('PATCH');
    const sent = JSON.parse(capturedBody);
    expect(sent.concurrency).toBe('queue');
    expect(sent.defaultInput).toEqual({ foo: 'bar' });
    // Unsupplied fields must not be sent.
    expect('name' in sent).toBe(false);
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.patched).toEqual(expect.arrayContaining(['concurrency', 'defaultInput']));
  });

  test('patches a cron expression end-to-end', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? '';
      return new Response(JSON.stringify({ success: true, automation: {} }), {
        status: 200,
      });
    }) as unknown as typeof globalThis.fetch;

    const r = await updateAutomationTool.handler(
      {
        automationId: 'auto_x',
        scheduleMode: 'cron',
        triggers: [{ type: 'schedule', config: { cron: '*/15 * * * *' } }],
      },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const sent = JSON.parse(capturedBody);
    expect(sent.scheduleMode).toBe('cron');
    expect(sent.triggers[0].config.cron).toBe('*/15 * * * *');
  });

  test('encodes automationId in the URL path', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await updateAutomationTool.handler(
      { automationId: 'has spaces & ?', name: 'x' },
      makeMockContext(),
    );
    expect(capturedUrl).toContain(encodeURIComponent('has spaces & ?'));
  });

  test('forwards bearer + user-id headers from state', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await updateAutomationTool.handler(
      { automationId: 'a', name: 'x' },
      makeMockContext({ state: { authToken: 'tok-u', userId: 'user-9' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-u');
    expect(capturedHeaders['X-User-Id']).toBe('user-9');
  });

  test('succeeds when the route returns no body', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 204 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', name: 'renamed' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).ok).toBe(true);
  });
});

describe('update_automation — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('403 (non-owner) surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', name: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(403);
    expect(body.automationId).toBe('auto_x');
  });

  test('404 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        statusText: 'Not Found',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await updateAutomationTool.handler(
      { automationId: 'auto_missing', name: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(404);
  });

  test('500 returns error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', name: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', name: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });
});
