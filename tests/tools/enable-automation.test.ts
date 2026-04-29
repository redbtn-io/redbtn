/**
 * Vitest for native tool: enable_automation
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import enableAutomationTool from '../../src/lib/tools/native/enable-automation';

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

describe('enable_automation — schema', () => {
  test('requires automationId', () => {
    expect(enableAutomationTool.description.toLowerCase()).toContain('enable');
    expect(enableAutomationTool.inputSchema.required).toEqual(['automationId']);
    expect(enableAutomationTool.inputSchema.properties.automationId).toBeDefined();
  });

  test('server label is automation', () => {
    expect(enableAutomationTool.server).toBe('automation');
  });
});

describe('enable_automation — validation', () => {
  test('missing automationId returns isError + VALIDATION', async () => {
    const r = await enableAutomationTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
  });

  test('empty automationId returns isError + VALIDATION', async () => {
    const r = await enableAutomationTool.handler(
      { automationId: '   ' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
  });
});

describe('enable_automation — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('POSTs to /enable and returns { ok: true, isEnabled: true }', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      capturedMethod = init?.method ?? 'GET';
      return new Response(
        JSON.stringify({
          success: true,
          automation: {
            automationId: 'auto_x',
            name: 'Daily',
            isEnabled: true,
            status: 'active',
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await enableAutomationTool.handler(
      { automationId: 'auto_x' },
      makeMockContext(),
    );

    expect(capturedUrl).toContain('/api/v1/automations/auto_x/enable');
    expect(capturedMethod).toBe('POST');
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.isEnabled).toBe(true);
    expect(body.automationId).toBe('auto_x');
  });

  test('falls back to isEnabled:true when route returns no body', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;

    const result = await enableAutomationTool.handler(
      { automationId: 'auto_y' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.isEnabled).toBe(true);
  });

  test('encodes automationId in URL path', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({ automation: { isEnabled: true } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await enableAutomationTool.handler(
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
        JSON.stringify({ automation: { isEnabled: true } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await enableAutomationTool.handler(
      { automationId: 'a' },
      makeMockContext({ state: { authToken: 'tok-z', userId: 'user-4' } }),
    );
    expect(capturedHeaders['Authorization']).toBe('Bearer tok-z');
    expect(capturedHeaders['X-User-Id']).toBe('user-4');
  });
});

describe('enable_automation — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('403 (member trying to enable) surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    ) as unknown as typeof globalThis.fetch;

    const r = await enableAutomationTool.handler(
      { automationId: 'auto_x' },
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

    const r = await enableAutomationTool.handler(
      { automationId: 'auto_missing' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(404);
  });

  test('500 returns error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await enableAutomationTool.handler(
      { automationId: 'auto_x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const r = await enableAutomationTool.handler(
      { automationId: 'auto_x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });
});
