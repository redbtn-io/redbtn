/**
 * Vitest for native tool: reprocess_document
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import reprocessDocumentTool from '../../src/lib/tools/native/reprocess-document';

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

describe('reprocess_document — schema', () => {
  test('libraryId + documentId required', () => {
    expect(reprocessDocumentTool.description.toLowerCase()).toContain('reprocess');
    expect(reprocessDocumentTool.inputSchema.required).toEqual([
      'libraryId',
      'documentId',
    ]);
  });
});

describe('reprocess_document — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('POSTs to /process and returns { ok: true, chunks }', async () => {
    let urlSeen = '';
    let methodSeen = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urlSeen = typeof input === 'string' ? input : (input as URL).toString();
      methodSeen = init?.method || 'GET';
      return new Response(
        JSON.stringify({ success: true, chunkCount: 9 }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await reprocessDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'd1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, chunks: 9 });
    expect(urlSeen).toContain('/api/v1/libraries/lib1/documents/d1/process');
    expect(methodSeen).toBe('POST');
  });
});

describe('reprocess_document — validation errors', () => {
  test('missing documentId returns VALIDATION', async () => {
    const r = await reprocessDocumentTool.handler(
      { libraryId: 'lib1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('reprocess_document — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('503 (e.g. OCR pipeline missing) surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('OCR pipeline unavailable', { status: 503, statusText: 'Service Unavailable' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await reprocessDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'd1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(503);
  });
});
