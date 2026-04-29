/**
 * Vitest for native tool: create_library
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import createLibraryTool from '../../src/lib/tools/native/create-library';

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

describe('create_library — schema', () => {
  test('exposes name (required) + description + metadata', () => {
    expect(createLibraryTool.description.toLowerCase()).toContain('library');
    expect(createLibraryTool.inputSchema.required).toEqual(['name']);
    expect(createLibraryTool.inputSchema.properties.name).toBeDefined();
    expect(createLibraryTool.inputSchema.properties.description).toBeDefined();
    expect(createLibraryTool.inputSchema.properties.metadata).toBeDefined();
  });
});

describe('create_library — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns { libraryId } on 201', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('/api/v1/libraries');
      expect(init?.method).toBe('POST');
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          success: true,
          library: { libraryId: 'lib-new', name: 'My Lib' },
        }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await createLibraryTool.handler(
      { name: 'My Lib', description: 'desc', metadata: { source: 'agent' } },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ libraryId: 'lib-new' });
    expect(captured.name).toBe('My Lib');
    expect(captured.description).toBe('desc');
    expect(captured.metadata).toEqual({ source: 'agent' });
  });

  test('omits optional fields when not supplied', async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({ library: { libraryId: 'lib-x' } }),
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;

    await createLibraryTool.handler({ name: 'Just Name' }, makeMockContext());
    expect(captured).toEqual({ name: 'Just Name' });
  });
});

describe('create_library — validation errors', () => {
  test('empty name returns VALIDATION', async () => {
    const r = await createLibraryTool.handler({ name: '   ' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('name longer than 100 chars returns VALIDATION', async () => {
    const r = await createLibraryTool.handler(
      { name: 'x'.repeat(101) },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('create_library — upstream error', () => {
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

    const r = await createLibraryTool.handler({ name: 'X' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
