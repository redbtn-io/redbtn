/**
 * Vitest for native tool: list_participants
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import listParticipantsTool from '../../src/lib/tools/native/list-participants';

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

describe('list_participants — schema', () => {
  test('requires conversationId', () => {
    expect(listParticipantsTool.inputSchema.required).toEqual(['conversationId']);
  });
});

describe('list_participants — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('projects participants to spec shape with addedAt mapping', async () => {
    const joinedAt = new Date().toISOString();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/conversations/c1/participants');
      return new Response(
        JSON.stringify({
          participants: [
            {
              userId: 'u1',
              role: 'owner',
              joinedAt,
              displayName: 'Alice',
              email: 'alice@example.com',
            },
            {
              userId: 'u2',
              role: 'member',
              joinedAt,
              displayName: 'Bob',
              email: 'bob@example.com',
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await listParticipantsTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.participants).toHaveLength(2);
    expect(body.participants[0].userId).toBe('u1');
    expect(body.participants[0].role).toBe('owner');
    expect(body.participants[0].addedAt).toBe(joinedAt);
    expect(body.participants[0].displayName).toBe('Alice');
    expect(body.participants[1].email).toBe('bob@example.com');
  });

  test('empty participants array', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ participants: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const r = await listParticipantsTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    expect(JSON.parse(r.content[0].text).participants).toEqual([]);
  });
});

describe('list_participants — validation errors', () => {
  test('missing conversationId returns isError', async () => {
    // @ts-expect-error
    const r = await listParticipantsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('list_participants — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('403 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
    ) as unknown as typeof globalThis.fetch;
    const r = await listParticipantsTool.handler(
      { conversationId: 'c1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(403);
  });
});
