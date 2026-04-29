/**
 * Vitest for native tool: get_document
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getDocumentTool from '../../src/lib/tools/native/get-document';

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

describe('get_document — schema', () => {
  test('libraryId + documentId required, format optional', () => {
    expect(getDocumentTool.description.toLowerCase()).toContain('document');
    expect(getDocumentTool.inputSchema.required).toEqual(['libraryId', 'documentId']);
    expect(getDocumentTool.inputSchema.properties.format.enum).toEqual([
      'full',
      'chunks',
      'metadata',
    ]);
  });
});

describe('get_document — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('format=metadata (default) hits the bare /:documentId route', async () => {
    let urlSeen = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urlSeen = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({ documentId: 'd1', title: 'note', chunkCount: 2 }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await getDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'd1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(urlSeen).toContain('/api/v1/libraries/lib1/documents/d1');
    expect(urlSeen).not.toContain('/full');
    expect(urlSeen).not.toContain('/chunks');
    const body = JSON.parse(r.content[0].text);
    expect(body.documentId).toBe('d1');
  });

  test('format=full hits /full and forwards content', async () => {
    let urlSeen = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urlSeen = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({ documentId: 'd1', content: 'full reconstructed text' }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await getDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'd1', format: 'full' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(urlSeen).toContain('/full');
    const body = JSON.parse(r.content[0].text);
    expect(body.content).toBe('full reconstructed text');
  });

  test('format=chunks hits /chunks', async () => {
    let urlSeen = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urlSeen = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({
          documentId: 'd1',
          chunks: [{ id: 'c1', text: 'hello' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await getDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'd1', format: 'chunks' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(urlSeen).toContain('/chunks');
    const body = JSON.parse(r.content[0].text);
    expect(body.chunks).toHaveLength(1);
  });
});

describe('get_document — validation errors', () => {
  test('missing libraryId returns VALIDATION', async () => {
    const r = await getDocumentTool.handler(
      { documentId: 'd1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('get_document — upstream error', () => {
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

    const r = await getDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'gone' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(404);
  });
});
