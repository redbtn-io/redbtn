/**
 * Vitest for native tool: add_participant
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import addParticipantTool from '../../src/lib/tools/native/add-participant';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('add_participant — schema', () => {
  test('requires conversationId, userId, role', () => {
    expect(addParticipantTool.inputSchema.required).toEqual([
      'conversationId',
      'userId',
      'role',
    ]);
    expect(addParticipantTool.inputSchema.properties.role.enum).toEqual([
      'member',
      'viewer',
    ]);
  });
});

describe('add_participant — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('POSTs userId + role to participants', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/conversations/c1/participants');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body || '{}'));
      expect(body.userId).toBe('u_invitee');
      expect(body.role).toBe('member');
      return new Response(
        JSON.stringify({ participant: { userId: 'u_invitee', role: 'member' } }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await addParticipantTool.handler(
      { conversationId: 'c1', userId: 'u_invitee', role: 'member' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true });
  });

  test('viewer role passes through', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ participant: {} }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    await addParticipantTool.handler(
      { conversationId: 'c1', userId: 'u', role: 'viewer' },
      makeMockContext(),
    );
    expect(captured.role).toBe('viewer');
  });
});

describe('add_participant — validation errors', () => {
  test('missing conversationId returns isError', async () => {
    // @ts-expect-error
    const r = await addParticipantTool.handler(
      { userId: 'u1', role: 'member' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing userId returns isError', async () => {
    // @ts-expect-error
    const r = await addParticipantTool.handler(
      { conversationId: 'c1', role: 'member' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('invalid role returns isError', async () => {
    // @ts-expect-error
    const r = await addParticipantTool.handler(
      { conversationId: 'c1', userId: 'u', role: 'admin' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('add_participant — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('403 surfaces status (non-owner caller)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
    ) as unknown as typeof globalThis.fetch;
    const r = await addParticipantTool.handler(
      { conversationId: 'c1', userId: 'u', role: 'member' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(403);
  });

  test('409 already participant surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Already participant', { status: 409, statusText: 'Conflict' }),
    ) as unknown as typeof globalThis.fetch;
    const r = await addParticipantTool.handler(
      { conversationId: 'c1', userId: 'u', role: 'member' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(409);
  });
});
