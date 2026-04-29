/**
 * Vitest for native tool: list_documents
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import listDocumentsTool from '../../src/lib/tools/native/list-documents';

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

describe('list_documents — schema', () => {
  test('libraryId required, limit/offset optional', () => {
    expect(listDocumentsTool.description.toLowerCase()).toContain('document');
    expect(listDocumentsTool.inputSchema.required).toEqual(['libraryId']);
    expect(listDocumentsTool.inputSchema.properties.limit).toBeDefined();
    expect(listDocumentsTool.inputSchema.properties.offset).toBeDefined();
  });
});

describe('list_documents — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns mapped documents + total', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('/api/v1/libraries/lib1');
      expect(u).toContain('page=');
      expect(u).toContain('limit=');
      return new Response(
        JSON.stringify({
          libraryId: 'lib1',
          documents: [
            {
              documentId: 'd1',
              source: 'a.md',
              chunkCount: 3,
              addedAt: '2026-04-01T00:00:00Z',
            },
            {
              documentId: 'd2',
              source: 'b.pdf',
              chunkCount: 7,
              addedAt: '2026-04-02T00:00:00Z',
            },
          ],
          pagination: { total: 12, page: 1, limit: 50, totalPages: 1 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await listDocumentsTool.handler(
      { libraryId: 'lib1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.total).toBe(12);
    expect(body.documents).toHaveLength(2);
    expect(body.documents[0]).toEqual({
      id: 'd1',
      filename: 'a.md',
      chunks: 3,
      createdAt: '2026-04-01T00:00:00Z',
    });
  });

  test('translates offset → page', async () => {
    let urlSeen = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urlSeen = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({ documents: [], pagination: { total: 0 } }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    await listDocumentsTool.handler(
      { libraryId: 'lib1', limit: 10, offset: 25 },
      makeMockContext(),
    );
    // offset=25, limit=10 → page = floor(25/10) + 1 = 3
    expect(urlSeen).toContain('page=3');
    expect(urlSeen).toContain('limit=10');
  });
});

describe('list_documents — validation errors', () => {
  test('missing libraryId returns VALIDATION', async () => {
    const r = await listDocumentsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('list_documents — upstream error', () => {
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

    const r = await listDocumentsTool.handler(
      { libraryId: 'libX' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(404);
  });
});
