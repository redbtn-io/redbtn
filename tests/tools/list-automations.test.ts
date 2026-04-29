/**
 * Vitest for native tool: list_automations
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import listAutomationsTool from '../../src/lib/tools/native/list-automations';

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

describe('list_automations — schema', () => {
  test('exposes enabled + search + limit, no required fields', () => {
    expect(listAutomationsTool.description.toLowerCase()).toContain('automations');
    expect(listAutomationsTool.inputSchema.required).toEqual([]);
    expect(listAutomationsTool.inputSchema.properties.enabled).toBeDefined();
    expect(listAutomationsTool.inputSchema.properties.search).toBeDefined();
    expect(listAutomationsTool.inputSchema.properties.limit).toBeDefined();
  });

  test('server label is automation', () => {
    expect(listAutomationsTool.server).toBe('automation');
  });
});

describe('list_automations — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns mapped automations with stable subset of fields', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      expect(capturedUrl).toContain('/api/v1/automations');
      expect(capturedUrl).toContain('limit=50');
      return new Response(
        JSON.stringify({
          success: true,
          automations: [
            {
              automationId: 'auto_a',
              name: 'Daily Briefing',
              description: 'Sends morning summary',
              graphId: 'graph_x',
              tags: ['daily', 'morning'],
              triggers: [{ type: 'schedule', config: { cron: '0 8 * * *' } }],
              isEnabled: true,
              status: 'active',
              stats: { runCount: 12 },
              isOwned: true,
            },
            {
              automationId: 'auto_b',
              name: 'Disabled Bot',
              graphId: 'graph_y',
              tags: [],
              triggers: [{ type: 'webhook', config: {} }],
              isEnabled: false,
              status: 'paused',
              stats: { runCount: 0 },
              isOwned: false,
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await listAutomationsTool.handler({}, makeMockContext());
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.automations).toHaveLength(2);
    expect(body.automations[0]).toMatchObject({
      automationId: 'auto_a',
      name: 'Daily Briefing',
      isEnabled: true,
      status: 'active',
      isOwned: true,
    });
    expect(body.automations[0].triggers).toEqual([
      { type: 'schedule', config: { cron: '0 8 * * *' } },
    ]);
  });

  test('search filter is forwarded as a query param', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ automations: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listAutomationsTool.handler({ search: 'briefing' }, makeMockContext());
    expect(capturedUrl).toContain('search=briefing');
  });

  test('enabled:true filters out disabled automations', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          automations: [
            { automationId: 'a', isEnabled: true },
            { automationId: 'b', isEnabled: false },
            { automationId: 'c', isEnabled: true },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await listAutomationsTool.handler({ enabled: true }, makeMockContext());
    const body = JSON.parse(r.content[0].text);
    expect(body.automations).toHaveLength(2);
    expect(
      body.automations.map((a: { automationId: string }) => a.automationId),
    ).toEqual(['a', 'c']);
  });

  test('enabled:false filters out enabled automations', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          automations: [
            { automationId: 'a', isEnabled: true },
            { automationId: 'b', isEnabled: false },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await listAutomationsTool.handler({ enabled: false }, makeMockContext());
    const body = JSON.parse(r.content[0].text);
    expect(body.automations).toHaveLength(1);
    expect(body.automations[0].automationId).toBe('b');
  });

  test('limit clamps the projected list', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          automations: Array.from({ length: 8 }, (_, i) => ({
            automationId: `a${i}`,
            isEnabled: true,
          })),
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await listAutomationsTool.handler({ limit: 3 }, makeMockContext());
    const body = JSON.parse(r.content[0].text);
    expect(body.automations).toHaveLength(3);
  });

  test('forwards Authorization header from state.authToken', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ automations: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listAutomationsTool.handler(
      {},
      makeMockContext({ state: { authToken: 'tok-x', userId: 'user-3' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-x');
    expect(capturedHeaders['X-User-Id']).toBe('user-3');
  });
});

describe('list_automations — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await listAutomationsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENETUNREACH');
    }) as unknown as typeof globalThis.fetch;

    const r = await listAutomationsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ENETUNREACH/);
  });
});
