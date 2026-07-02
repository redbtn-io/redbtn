import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
}));

vi.mock('mongoose', () => {
  const fake = {
    connection: {
      db: {
        collection: () => ({
          findOne: (...args: unknown[]) => mocks.findOne(...args),
        }),
      },
    },
  };
  return { default: fake, ...fake };
});

function makeContext(): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1', authToken: 'jwt-test' },
    runId: 'run-1',
    nodeId: 'node-1',
    toolId: 'tool-1',
    abortSignal: null,
  };
}

describe('search_documents', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.WEBAPP_URL;
  });

  test('uses libraryId to search through the library API', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          results: [
            { id: 'r1', text: 'answer', score: 0.9, metadata: { source: 'doc.md' } },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const tool = (await import('../../src/lib/tools/native/search-documents')).default;
    const result = await tool.handler(
      { libraryId: 'lib-1', query: 'hello', topK: 3, threshold: 0.2 },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://test-webapp.example/api/v1/libraries/lib-1/search');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-test');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      query: 'hello',
      limit: 3,
      threshold: 0.2,
    });
    expect(result.content[0].text).toContain('answer');
  });

  test('resolves legacy collection names to active libraries before searching', async () => {
    mocks.findOne.mockResolvedValueOnce({ libraryId: 'lib-resolved' });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const tool = (await import('../../src/lib/tools/native/search-documents')).default;
    const result = await tool.handler(
      { collection: 'col-1', query: 'hello' },
      makeContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(mocks.findOne).toHaveBeenCalledWith(
      { vectorCollection: 'col-1', isArchived: { $ne: true } },
      { projection: { libraryId: 1 } },
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://test-webapp.example/api/v1/libraries/lib-resolved/search',
      expect.any(Object),
    );
  });

  test('rejects raw search when neither libraryId nor resolvable collection is supplied', async () => {
    const tool = (await import('../../src/lib/tools/native/search-documents')).default;
    const result = await tool.handler({ query: 'hello' }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('libraryId is required');
  });
});
