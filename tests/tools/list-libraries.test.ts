/**
 * Vitest for native tool: list_libraries
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import listLibrariesTool from '../../src/lib/tools/native/list-libraries';

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

describe('list_libraries — schema', () => {
  test('exposes search + limit, no required fields', () => {
    expect(listLibrariesTool.description.toLowerCase()).toContain('libraries');
    expect(listLibrariesTool.inputSchema.required).toEqual([]);
    expect(listLibrariesTool.inputSchema.properties.search).toBeDefined();
    expect(listLibrariesTool.inputSchema.properties.limit).toBeDefined();
  });
});

describe('list_libraries — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('returns mapped libraries (id/name/description/documentCount)', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('/api/v1/libraries');
      expect(u).toContain('includeShared=true');
      return new Response(
        JSON.stringify({
          libraries: [
            { libraryId: 'lib1', name: 'A', description: 'Alpha', documentCount: 5 },
            { libraryId: 'lib2', name: 'B', description: '',     documentCount: 2 },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await listLibrariesTool.handler({}, makeMockContext());
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.libraries).toHaveLength(2);
    expect(body.libraries[0]).toEqual({
      id: 'lib1',
      name: 'A',
      description: 'Alpha',
      documentCount: 5,
    });
  });

  test('client-side search filter narrows by name/description', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          libraries: [
            { libraryId: 'lib1', name: 'Cooking notes', description: '' },
            { libraryId: 'lib2', name: 'Travel ideas', description: '' },
            { libraryId: 'lib3', name: 'X', description: 'Recipe brainstorm' },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await listLibrariesTool.handler(
      { search: 'cook' },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.libraries).toHaveLength(1);
    expect(body.libraries[0].id).toBe('lib1');
  });

  test('limit clamps the result list', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          libraries: Array.from({ length: 5 }, (_, i) => ({
            libraryId: `lib${i}`,
            name: `L${i}`,
          })),
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const r = await listLibrariesTool.handler({ limit: 2 }, makeMockContext());
    const body = JSON.parse(r.content[0].text);
    expect(body.libraries).toHaveLength(2);
  });
});

describe('list_libraries — upstream error', () => {
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

    const r = await listLibrariesTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });

  test('fetch rejection surfaces error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const r = await listLibrariesTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });
});
