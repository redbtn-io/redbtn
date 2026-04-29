/**
 * Vitest for native tool: update_document
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import updateDocumentTool from '../../src/lib/tools/native/update-document';

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

describe('update_document — schema', () => {
  test('libraryId + documentId required, content/metadata/title optional', () => {
    expect(updateDocumentTool.description.toLowerCase()).toContain('document');
    expect(updateDocumentTool.inputSchema.required).toEqual([
      'libraryId',
      'documentId',
    ]);
    expect(updateDocumentTool.inputSchema.properties.content).toBeDefined();
    expect(updateDocumentTool.inputSchema.properties.metadata).toBeDefined();
    expect(updateDocumentTool.inputSchema.properties.title).toBeDefined();
  });
});

describe('update_document — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('content update returns reprocessed: true', async () => {
    let urlSeen = '';
    let methodSeen = '';
    let captured: any = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urlSeen = typeof input === 'string' ? input : (input as URL).toString();
      methodSeen = init?.method || 'GET';
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({ success: true, reprocessed: true }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await updateDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'd1', content: 'new body' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({
      ok: true,
      reprocessed: true,
    });
    expect(urlSeen).toContain('/api/v1/libraries/lib1/documents/d1');
    expect(methodSeen).toBe('PATCH');
    expect(captured.content).toBe('new body');
  });

  test('metadata-only update returns reprocessed: false', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, reprocessed: false }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await updateDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'd1', metadata: { tag: 'x' } },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({
      ok: true,
      reprocessed: false,
    });
  });
});

describe('update_document — validation errors', () => {
  test('no fields to update returns VALIDATION', async () => {
    const r = await updateDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'd1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing documentId returns VALIDATION', async () => {
    const r = await updateDocumentTool.handler(
      { libraryId: 'lib1', content: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('update_document — upstream error', () => {
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

    const r = await updateDocumentTool.handler(
      { libraryId: 'lib1', documentId: 'd1', content: 'x' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
