/**
 * Vitest for native tool: search_all_libraries
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import searchAllLibrariesTool from '../../src/lib/tools/native/search-all-libraries';

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

describe('search_all_libraries — schema', () => {
  test('exposes query (required) + filter inputs', () => {
    expect(searchAllLibrariesTool.description.toLowerCase()).toContain('libraries');
    expect(searchAllLibrariesTool.inputSchema.required).toEqual(['query']);
    expect(searchAllLibrariesTool.inputSchema.properties.query).toBeDefined();
    expect(searchAllLibrariesTool.inputSchema.properties.limit).toBeDefined();
    expect(searchAllLibrariesTool.inputSchema.properties.libraryIds).toBeDefined();
    expect(searchAllLibrariesTool.inputSchema.properties.minScore).toBeDefined();
  });
});

describe('search_all_libraries — happy path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('lists libraries then fans out search across each, returns merged sorted results', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      calls.push(u);
      const url = new URL(u);
      if (url.pathname === '/api/v1/libraries') {
        return new Response(
          JSON.stringify({
            libraries: [
              { libraryId: 'libA', name: 'A' },
              { libraryId: 'libB', name: 'B' },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.pathname === '/api/v1/libraries/libA/search') {
        return new Response(
          JSON.stringify({
            results: [
              { id: '1', text: 'apple pie', score: 0.91, metadata: { documentId: 'docA1' } },
              { id: '2', text: 'orange',     score: 0.55, metadata: { documentId: 'docA2' } },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.pathname === '/api/v1/libraries/libB/search') {
        return new Response(
          JSON.stringify({
            results: [
              { id: '3', text: 'banana',  score: 0.95, metadata: { documentId: 'docB1' } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const result = await searchAllLibrariesTool.handler(
      { query: 'fruit', limit: 5 },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.results.length).toBe(3);
    // Sort by score descending → docB1 (0.95), docA1 (0.91), docA2 (0.55)
    expect(body.results[0].documentId).toBe('docB1');
    expect(body.results[0].libraryId).toBe('libB');
    expect(body.results[1].documentId).toBe('docA1');
    expect(body.results[2].documentId).toBe('docA2');
    // Confirms it called both library search endpoints
    expect(calls.some(u => u.includes('/libA/search'))).toBe(true);
    expect(calls.some(u => u.includes('/libB/search'))).toBe(true);
  });

  test('filters by libraryIds (skips list step)', async () => {
    let listCalled = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      const url = new URL(u);
      if (url.pathname === '/api/v1/libraries') {
        listCalled = true;
        return new Response('not allowed', { status: 500 });
      }
      // Both /libC and /libD return identical 1-result payloads.
      return new Response(
        JSON.stringify({
          results: [{ id: 'x', text: 'x', score: 0.8, metadata: { documentId: 'd' } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await searchAllLibrariesTool.handler(
      { query: 'q', libraryIds: ['libC', 'libD'] },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    expect(listCalled).toBe(false);
    const body = JSON.parse(r.content[0].text);
    expect(body.results.length).toBe(2);
  });

  test('minScore filters out below-threshold results', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      const url = new URL(u);
      if (url.pathname === '/api/v1/libraries') {
        return new Response(
          JSON.stringify({ libraries: [{ libraryId: 'libA' }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          results: [
            { id: '1', text: 'high', score: 0.9, metadata: { documentId: 'd1' } },
            { id: '2', text: 'low',  score: 0.3, metadata: { documentId: 'd2' } },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const r = await searchAllLibrariesTool.handler(
      { query: 'q', minScore: 0.5 },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].documentId).toBe('d1');
  });
});

describe('search_all_libraries — validation', () => {
  test('empty query returns VALIDATION', async () => {
    const r = await searchAllLibrariesTool.handler({ query: '   ' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('search_all_libraries — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('list libraries 500 surfaces error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await searchAllLibrariesTool.handler(
      { query: 'q' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).status).toBe(500);
  });
});
