/**
 * Vitest for native tool: update_automation
 *
 * Covers the canonical-status compatibility shim added in phase 5 of
 * strategicTodo `automation-status-fields-cleanup` (spec:
 * explanations/automation-status-spec.md). Until phase 6 flips the webapp
 * PATCH endpoint to accept `status` directly, the engine tool translates
 * a `status` argument into the equivalent `isEnabled` boolean so the
 * existing endpoint pair-writes both fields correctly.
 *
 * Cases:
 *   - pause:  status:'paused' → PATCH body has isEnabled:false
 *   - resume: status:'active' → PATCH body has isEnabled:true
 *   - other:  status:'disabled' / status:'error' → PATCH body has isEnabled:false
 *   - validation: invalid status → VALIDATION error before fetch
 *   - explicit isEnabled wins when both supplied (caller's choice)
 *   - back-compat: callers passing isEnabled only continue to work
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

function buildFetchSpy(): {
  spy: ReturnType<typeof vi.fn>;
  getCapturedBody: () => any;
  getCapturedUrl: () => string;
  getCapturedMethod: () => string;
} {
  let capturedBody: any = null;
  let capturedUrl = '';
  let capturedMethod = '';
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
    capturedMethod = init?.method ?? 'GET';
    try {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
    } catch {
      capturedBody = init?.body;
    }
    return new Response(
      JSON.stringify({
        success: true,
        automation: {
          automationId: 'auto_x',
          name: 'Daily',
          status: capturedBody?.isEnabled === false ? 'paused' : 'active',
          isEnabled: capturedBody?.isEnabled !== false,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  return {
    spy,
    getCapturedBody: () => capturedBody,
    getCapturedUrl: () => capturedUrl,
    getCapturedMethod: () => capturedMethod,
  };
}

describe('update_automation — schema', () => {
  test('exposes the canonical `status` field in the input schema', () => {
    const props = updateAutomationTool.inputSchema.properties as Record<string, any>;
    expect(props.status).toBeDefined();
    expect(props.status.enum).toEqual(['active', 'paused', 'disabled', 'error']);
  });

  test('description mentions the pause/resume contract', () => {
    expect(updateAutomationTool.description).toMatch(/status:/);
    expect(updateAutomationTool.description).toMatch(/pause/i);
  });

  test('requires only automationId', () => {
    expect(updateAutomationTool.inputSchema.required).toEqual(['automationId']);
  });
});

describe('update_automation — validation', () => {
  test('missing automationId returns isError + VALIDATION', async () => {
    const r = await updateAutomationTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
  });

  test('invalid status enum returns isError + VALIDATION before fetch', async () => {
    const originalFetch = globalThis.fetch;
    const { spy } = buildFetchSpy();
    globalThis.fetch = spy as any;
    try {
      const r = await updateAutomationTool.handler(
        { automationId: 'auto_x', status: 'garbage' },
        makeMockContext(),
      );
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text);
      expect(body.code).toBe('VALIDATION');
      // Fetch must NOT have been called — validation rejects first.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('update_automation — status translation shim', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('pause: status:"paused" → PATCH body has isEnabled:false', async () => {
    const { spy, getCapturedBody, getCapturedUrl, getCapturedMethod } = buildFetchSpy();
    globalThis.fetch = spy as any;

    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', status: 'paused' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = getCapturedBody();
    expect(body).toMatchObject({ isEnabled: false });
    // The status field must NOT be forwarded (endpoint doesn't accept it yet).
    expect(body.status).toBeUndefined();
    expect(getCapturedMethod()).toBe('PATCH');
    expect(getCapturedUrl()).toContain('/api/v1/automations/auto_x');
  });

  test('resume: status:"active" → PATCH body has isEnabled:true', async () => {
    const { spy, getCapturedBody } = buildFetchSpy();
    globalThis.fetch = spy as any;

    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', status: 'active' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = getCapturedBody();
    expect(body).toMatchObject({ isEnabled: true });
    expect(body.status).toBeUndefined();
  });

  test.each(['disabled', 'error'] as const)(
    'status:%s → PATCH body has isEnabled:false (only `active` maps to true)',
    async (nonActiveStatus) => {
      const { spy, getCapturedBody } = buildFetchSpy();
      globalThis.fetch = spy as any;

      const r = await updateAutomationTool.handler(
        { automationId: 'auto_x', status: nonActiveStatus },
        makeMockContext(),
      );
      expect(r.isError).toBeFalsy();
      const body = getCapturedBody();
      expect(body).toMatchObject({ isEnabled: false });
    },
  );

  test('explicit isEnabled is preserved when caller passes both', async () => {
    const { spy, getCapturedBody } = buildFetchSpy();
    globalThis.fetch = spy as any;

    // status:'paused' would normally set isEnabled:false, but explicit
    // isEnabled:true from the caller wins — the shim only fills in the
    // derived value when isEnabled is undefined.
    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', status: 'paused', isEnabled: true },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(getCapturedBody()).toMatchObject({ isEnabled: true });
  });

  test('back-compat: caller passing only isEnabled still works (no status)', async () => {
    const { spy, getCapturedBody } = buildFetchSpy();
    globalThis.fetch = spy as any;

    const r = await updateAutomationTool.handler(
      { automationId: 'auto_x', isEnabled: false },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(getCapturedBody()).toMatchObject({ isEnabled: false });
  });

  test('non-status patch fields pass through unchanged (description, tags)', async () => {
    const { spy, getCapturedBody } = buildFetchSpy();
    globalThis.fetch = spy as any;

    await updateAutomationTool.handler(
      {
        automationId: 'auto_x',
        description: 'updated',
        tags: ['a', 'b'],
      },
      makeMockContext(),
    );
    expect(getCapturedBody()).toMatchObject({ description: 'updated', tags: ['a', 'b'] });
    // No status / isEnabled writes when neither is supplied.
    expect(getCapturedBody().status).toBeUndefined();
    expect(getCapturedBody().isEnabled).toBeUndefined();
  });
});

describe('update_automation — pause/resume round-trip parity', () => {
  test('pause then resume yields symmetric PATCH bodies', async () => {
    process.env.WEBAPP_URL = 'http://test-webapp.example';
    const captured: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      captured.push(body);
      return new Response(JSON.stringify({ success: true, automation: { automationId: 'auto_x' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as any;

    try {
      await updateAutomationTool.handler({ automationId: 'auto_x', status: 'paused' }, makeMockContext());
      await updateAutomationTool.handler({ automationId: 'auto_x', status: 'active' }, makeMockContext());

      expect(captured).toHaveLength(2);
      expect(captured[0].isEnabled).toBe(false);
      expect(captured[1].isEnabled).toBe(true);
      // Neither call should leak `status` to the webapp endpoint until phase 6.
      expect(captured[0].status).toBeUndefined();
      expect(captured[1].status).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
