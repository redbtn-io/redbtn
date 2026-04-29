/**
 * Vitest for native tool: upload_to_library
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import uploadToLibraryTool from '../../src/lib/tools/native/upload-to-library';

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

describe('upload_to_library — schema', () => {
  test('all four binary fields required', () => {
    expect(uploadToLibraryTool.description.toLowerCase()).toContain('upload');
    expect(uploadToLibraryTool.inputSchema.required).toEqual([
      'libraryId',
      'fileBase64',
      'filename',
      'mimeType',
    ]);
  });
});

describe('upload_to_library — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('POSTs multipart to /upload and returns { documentId, chunks }', async () => {
    let urlSeen = '';
    let methodSeen = '';
    let bodyTypeSeen: unknown = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urlSeen = typeof input === 'string' ? input : (input as URL).toString();
      methodSeen = init?.method || 'GET';
      bodyTypeSeen = init?.body;
      return new Response(
        JSON.stringify({
          success: true,
          document: { documentId: 'doc_pdf', chunkCount: 5 },
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const fileBase64 = Buffer.from('PDF-1.4 fake').toString('base64');
    const r = await uploadToLibraryTool.handler(
      {
        libraryId: 'lib1',
        fileBase64,
        filename: 'paper.pdf',
        mimeType: 'application/pdf',
      },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({
      documentId: 'doc_pdf',
      chunks: 5,
    });
    expect(urlSeen).toContain('/api/v1/libraries/lib1/upload');
    expect(methodSeen).toBe('POST');
    expect(bodyTypeSeen instanceof FormData).toBe(true);
  });
});

describe('upload_to_library — validation errors', () => {
  test('missing filename returns VALIDATION', async () => {
    const r = await uploadToLibraryTool.handler(
      {
        libraryId: 'lib1',
        fileBase64: 'aGVsbG8=',
        mimeType: 'text/plain',
      },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing mimeType returns VALIDATION', async () => {
    const r = await uploadToLibraryTool.handler(
      {
        libraryId: 'lib1',
        fileBase64: 'aGVsbG8=',
        filename: 'a.txt',
      },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('upload_to_library — upstream error', () => {
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

    const r = await uploadToLibraryTool.handler(
      {
        libraryId: 'lib1',
        fileBase64: 'aGVsbG8=',
        filename: 'a.txt',
        mimeType: 'text/plain',
      },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
