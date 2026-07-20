import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fetchUrlTool from '../../src/lib/tools/native/fetch-url';

function context(): any {
  return {
    publisher: null,
    state: { authToken: 'run-token', userId: 'run-user' },
    runId: 'run-redirect-auth',
    nodeId: 'node-redirect-auth',
    toolId: 'tool-redirect-auth',
    abortSignal: null,
  };
}

describe('fetch_url — credentialed redirects', () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedRedirect: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedRedirect = init?.redirect;
      return new Response('redirect response', { status: 200 });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('forces manual redirect handling after attaching internal credentials', async () => {
    await fetchUrlTool.handler(
      { url: 'https://app.redbtn.io/api/internal', followRedirects: true },
      context(),
    );

    expect(capturedRedirect).toBe('manual');
  });
});
