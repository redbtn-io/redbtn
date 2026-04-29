/**
 * Vitest for native tool: delete_library
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import deleteLibraryTool from '../../src/lib/tools/native/delete-library';

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

describe('delete_library — schema', () => {
  test('libraryId required', () => {
    expect(deleteLibraryTool.description.toLowerCase()).toContain('library');
    expect(deleteLibraryTool.inputSchema.required).toEqual(['libraryId']);
  });
});

describe('delete_library — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('peeks library doc count, then DELETEs (permanent), reports deletedDocuments', async () => {
    let deleteUrlSeen = '';
    let methodSeen = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      const url = new URL(u);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET' && url.pathname === '/api/v1/libraries/lib1') {
        return new Response(
          JSON.stringify({ libraryId: 'lib1', documentCount: 7 }),
          { status: 200 },
        );
      }
      if (method === 'DELETE') {
        deleteUrlSeen = u;
        methodSeen = method;
        return new Response(
          JSON.stringify({ success: true, deleted: true }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteLibraryTool.handler(
      { libraryId: 'lib1' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({
      ok: true,
      deletedDocuments: 7,
    });
    expect(deleteUrlSeen).toContain('permanent=true');
    expect(methodSeen).toBe('DELETE');
  });

  test('reports 0 deletedDocuments when peek fails', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return new Response('not allowed', { status: 403 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteLibraryTool.handler(
      { libraryId: 'lib2' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({
      ok: true,
      deletedDocuments: 0,
    });
  });
});

describe('delete_library — validation errors', () => {
  test('missing libraryId returns VALIDATION', async () => {
    const r = await deleteLibraryTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('delete_library — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('DELETE 500 surfaces status', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return new Response(JSON.stringify({ documentCount: 0 }), { status: 200 });
      }
      return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
    }) as unknown as typeof globalThis.fetch;

    const r = await deleteLibraryTool.handler(
      { libraryId: 'lib1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
