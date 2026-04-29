/**
 * Vitest for native tool: delete_document
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import deleteDocumentTool from '../../src/lib/tools/native/delete-document';

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

describe('delete_document — schema', () => {
  test('libraryId + documentId required', () => {
    expect(deleteDocumentTool.description.toLowerCase()).toContain('document');
    expect(deleteDocumentTool.inputSchema.required).toEqual([
      'libraryId',
      'documentId',
    ]);
  });
});

describe('delete_document — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('DELETEs and returns { ok: true }', async () => {
    let urlSeen = '';
    let methodSeen = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urlSeen = typeof input === 'string' ? input : (input as URL).toString();
      methodSeen = init?.method || 'GET';
      return new Response(
        JSON.stringify({ success: true, deleted: 'd1' }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'd1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true });
    expect(urlSeen).toContain('/api/v1/libraries/lib1/documents/d1');
    expect(methodSeen).toBe('DELETE');
  });
});

describe('delete_document — validation errors', () => {
  test('missing documentId returns VALIDATION', async () => {
    const r = await deleteDocumentTool.handler(
      { libraryId: 'lib1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('delete_document — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('404 surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await deleteDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'gone' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(404);
  });
});
