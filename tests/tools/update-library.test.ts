/**
 * Vitest for native tool: update_library
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import updateLibraryTool from '../../src/lib/tools/native/update-library';

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

describe('update_library — schema', () => {
  test('exposes libraryId (required) + name/description/metadata', () => {
    expect(updateLibraryTool.description.toLowerCase()).toContain('library');
    expect(updateLibraryTool.inputSchema.required).toEqual(['libraryId']);
    expect(updateLibraryTool.inputSchema.properties.libraryId).toBeDefined();
    expect(updateLibraryTool.inputSchema.properties.name).toBeDefined();
    expect(updateLibraryTool.inputSchema.properties.description).toBeDefined();
    expect(updateLibraryTool.inputSchema.properties.metadata).toBeDefined();
  });
});

describe('update_library — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('PATCHes library and returns { ok: true }', async () => {
    let captured: any = null;
    let urlSeen = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urlSeen = typeof input === 'string' ? input : (input as URL).toString();
      expect(init?.method).toBe('PATCH');
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({ success: true, updated: ['name'] }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await updateLibraryTool.handler(
      { libraryId: 'lib1', name: 'Renamed' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true });
    expect(urlSeen).toContain('/api/v1/libraries/lib1');
    expect(captured.name).toBe('Renamed');
  });
});

describe('update_library — validation errors', () => {
  test('missing libraryId returns VALIDATION', async () => {
    const r = await updateLibraryTool.handler({ name: 'x' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('no fields to update returns VALIDATION', async () => {
    const r = await updateLibraryTool.handler(
      { libraryId: 'lib1' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('update_library — upstream error', () => {
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
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await updateLibraryTool.handler(
      { libraryId: 'lib1', name: 'X' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(403);
  });
});
