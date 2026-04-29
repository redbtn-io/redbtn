/**
 * Vitest for native tool: get_automation
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getAutomationTool from '../../src/lib/tools/native/get-automation';

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

describe('get_automation — schema', () => {
  test('requires automationId', () => {
    expect(getAutomationTool.description.toLowerCase()).toContain('automation');
    expect(getAutomationTool.inputSchema.required).toEqual(['automationId']);
    expect(getAutomationTool.inputSchema.properties.automationId).toBeDefined();
  });

  test('server label is automation', () => {
    expect(getAutomationTool.server).toBe('automation');
  });
});

describe('get_automation — validation', () => {
  test('missing automationId returns isError + VALIDATION', async () => {
    const r = await getAutomationTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/automationId/);
  });

  test('empty automationId returns isError + VALIDATION', async () => {
    const r = await getAutomationTool.handler({ automationId: '   ' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('get_automation — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns full automation (unwrapped from { automation: ... })', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      expect(capturedUrl).toContain('/api/v1/automations/auto_x');
      return new Response(
        JSON.stringify({
          success: true,
          automation: {
            automationId: 'auto_x',
            name: 'Daily Briefing',
            description: 'Sends morning summary',
            graphId: 'graph_y',
            triggers: [{ type: 'schedule', config: { cron: '0 8 * * *' } }],
            inputMapping: {},
            defaultInput: { topic: 'news' },
            secretNames: ['OPENAI_API_KEY'],
            outputActions: [],
            isEnabled: true,
            status: 'active',
            stats: { runCount: 12, successCount: 11, failureCount: 1 },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await getAutomationTool.handler(
      { automationId: 'auto_x' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.automation.automationId).toBe('auto_x');
    expect(body.automation.name).toBe('Daily Briefing');
    expect(body.automation.triggers).toHaveLength(1);
    expect(body.automation.defaultInput).toEqual({ topic: 'news' });
    expect(body.automation.stats.runCount).toBe(12);
  });

  test('encodes automationId in URL path', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ automation: {} }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await getAutomationTool.handler(
      { automationId: 'has spaces & ?' },
      makeMockContext(),
    );
    expect(capturedUrl).toContain(encodeURIComponent('has spaces & ?'));
  });

  test('forwards bearer + user-id headers from state', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({ automation: { automationId: 'a' } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await getAutomationTool.handler(
      { automationId: 'a' },
      makeMockContext({ state: { authToken: 'tok-y', userId: 'user-9' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-y');
    expect(capturedHeaders['X-User-Id']).toBe('user-9');
  });
});

describe('get_automation — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('404 surfaces status + automationId', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Automation not found' }), {
        status: 404,
        statusText: 'Not Found',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getAutomationTool.handler(
      { automationId: 'auto_missing' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(404);
    expect(body.automationId).toBe('auto_missing');
  });

  test('500 returns error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await getAutomationTool.handler(
      { automationId: 'auto_x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    }) as unknown as typeof globalThis.fetch;

    const r = await getAutomationTool.handler(
      { automationId: 'auto_x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ETIMEDOUT/);
  });
});
