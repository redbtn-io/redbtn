/**
 * Vitest for native tool: add_document (consolidated)
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 * Covers both ingestion paths (text content + binary fileBase64).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import addDocumentTool from '../../src/lib/tools/native/add-document';

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

describe('add_document — schema', () => {
  test('exposes content + fileBase64 paths with libraryId required', () => {
    expect(addDocumentTool.description.toLowerCase()).toContain('document');
    expect(addDocumentTool.inputSchema.required).toEqual(['libraryId']);
    expect(addDocumentTool.inputSchema.properties.libraryId).toBeDefined();
    expect(addDocumentTool.inputSchema.properties.content).toBeDefined();
    expect(addDocumentTool.inputSchema.properties.fileBase64).toBeDefined();
    expect(addDocumentTool.inputSchema.properties.metadata).toBeDefined();
    expect(addDocumentTool.inputSchema.properties.filename).toBeDefined();
  });

  test('server is "library"', () => {
    expect(addDocumentTool.server).toBe('library');
  });
});

describe('add_document — text content path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns { documentId, chunks } when content is provided', async () => {
    let captured: { url: string; body: any } | null = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      captured = { url: u, body: JSON.parse(String(init?.body || '{}')) };
      return new Response(
        JSON.stringify({
          success: true,
          document: {
            documentId: 'doc_abc',
            title: 'My Note',
            chunkCount: 4,
            charCount: 120,
            addedAt: '2026-04-27T00:00:00Z',
          },
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await addDocumentTool.handler(
      {
        libraryId: 'lib1',
        content: 'Some text body here',
        title: 'My Note',
      },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      documentId: 'doc_abc',
      chunks: 4,
    });
    expect(captured!.url).toContain('/api/v1/libraries/lib1/documents');
    expect(captured!.body.content).toBe('Some text body here');
    expect(captured!.body.title).toBe('My Note');
    expect(captured!.body.sourceType).toBe('text');
  });

  test('forwards metadata and sourceType when provided', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({ document: { documentId: 'doc_x', chunkCount: 1 } }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    await addDocumentTool.handler(
      {
        libraryId: 'lib1',
        content: 'x',
        sourceType: 'automation',
        metadata: { source: 'agent' },
        filename: 'note.md',
      },
      makeMockContext(),
    );
    expect(captured.sourceType).toBe('automation');
    expect(captured.metadata).toEqual({ source: 'agent' });
    expect(captured.source).toBe('note.md');
  });
});

describe('add_document — binary fileBase64 path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('uploads via /upload (multipart) and returns documentId + chunks', async () => {
    let urlSeen = '';
    let bodyTypeSeen: unknown = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urlSeen = typeof input === 'string' ? input : (input as URL).toString();
      bodyTypeSeen = init?.body;
      return new Response(
        JSON.stringify({
          document: {
            documentId: 'doc_pdf',
            title: 'Whitepaper',
            chunkCount: 12,
            charCount: 5000,
          },
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const fileBase64 = Buffer.from('PDF-1.4 fake').toString('base64');
    const result = await addDocumentTool.handler(
      {
        libraryId: 'lib2',
        fileBase64,
        filename: 'paper.pdf',
        mimeType: 'application/pdf',
      },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      documentId: 'doc_pdf',
      chunks: 12,
    });
    expect(urlSeen).toContain('/api/v1/libraries/lib2/upload');
    expect(bodyTypeSeen instanceof FormData).toBe(true);
  });

  test('binary path requires filename', async () => {
    const result = await addDocumentTool.handler(
      {
        libraryId: 'lib2',
        fileBase64: Buffer.from('x').toString('base64'),
      },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('VALIDATION');
  });
});

describe('add_document — validation errors', () => {
  test('missing libraryId returns VALIDATION', async () => {
    const r = await addDocumentTool.handler(
      { content: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing both content + fileBase64 returns VALIDATION', async () => {
    const r = await addDocumentTool.handler(
      { libraryId: 'lib1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('content + fileBase64 both supplied returns VALIDATION', async () => {
    const r = await addDocumentTool.handler(
      {
        libraryId: 'lib1',
        content: 'x',
        fileBase64: Buffer.from('y').toString('base64'),
        filename: 'a.txt',
      },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('add_document — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 from text path surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await addDocumentTool.handler(
      { libraryId: 'lib1', content: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const r = await addDocumentTool.handler(
      { libraryId: 'lib1', content: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });
});
