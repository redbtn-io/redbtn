import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

const mocks = vi.hoisted(() => ({
  collection: vi.fn(),
}));

vi.mock('mongoose', () => {
  const fake = {
    connection: {
      db: {
        collection: (...args: unknown[]) => mocks.collection(...args),
      },
    },
    mongo: {
      GridFSBucket: class {},
    },
    Types: {
      ObjectId: class {
        static isValid() { return true; }
        constructor(public id: string) {}
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

describe('ssh_copy Knowledge Library source access', () => {
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

  test('denies library source mode before reading Mongo/GridFS when library API access fails', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, statusText: 'Forbidden' }),
    ) as unknown as typeof globalThis.fetch;

    const tool = (await import('../../src/lib/tools/native/ssh-copy')).default;
    const result = await tool.handler(
      {
        environmentId: 'env-1',
        remotePath: '/tmp/out',
        libraryId: 'lib-private',
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Knowledge Library access denied');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://test-webapp.example/api/v1/libraries/lib-private?limit=1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-test',
          'X-User-Id': 'user-1',
        }),
      }),
    );
    expect(mocks.collection).not.toHaveBeenCalled();
  });
});
