/**
 * fetch_url abort message distinction
 *
 * Confirms the fetch_url tool's catch block produces a message that reflects
 * which source triggered the AbortError:
 *   - external run signal → "fetch_url aborted by caller"
 *   - per-attempt timer   → "Request timed out after Xms"
 *
 * Before this fix, every AbortError was reported as "Request timed out after
 * Xms" — so an external interrupt firing in the first 100ms would show the
 * caller a misleading "timed out after 300000ms" message. The fix tracks
 * `timeoutFired` (only set by the timer) and `runAbortSignal.aborted` (set
 * when the run-level signal aborts) so the catch can attribute correctly.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fetchUrlTool from '../../src/lib/tools/native/fetch-url';

function buildContext(signal: AbortSignal): any {
  return {
    publisher: null,
    state: { userId: 'u-fetch-url-abort' },
    runId: 'r-fetch-url-abort',
    nodeId: 'n-fetch-url-abort',
    toolId: 't-fetch-url-abort',
    abortSignal: signal,
  };
}

describe('fetch_url — abort message distinguishes external signal from timeout', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('reports "aborted by caller" when an external signal triggers the abort', async () => {
    // Mock fetch to wait until the signal aborts then throw an AbortError
    // (matching native fetch behavior).
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      const sig: AbortSignal | undefined = init?.signal;
      return new Promise((_, reject) => {
        if (sig?.aborted) {
          const err: Error & { name: string } = new Error('AbortError');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        sig?.addEventListener('abort', () => {
          const err: Error & { name: string } = new Error('AbortError');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
    }) as any;

    const controller = new AbortController();
    const ctx = buildContext(controller.signal);

    // Abort after a short delay so the per-attempt timer (60_000ms) does NOT
    // fire — we want pure run-signal abort attribution.
    setTimeout(() => controller.abort(), 30);

    const result = await fetchUrlTool.handler(
      { url: 'http://test.invalid/path', timeout: 60_000 },
      ctx,
    );

    expect((result as any).isError).toBe(true);
    const text = (result as any).content?.[0]?.text || '';
    const parsed = JSON.parse(text);
    expect(parsed.error).toMatch(/aborted by caller/);
    // Critically: should NOT report "timed out after"
    expect(parsed.error).not.toMatch(/timed out after/);
  });

  test('reports "Request timed out after Xms" when the per-attempt timer fires (no external abort)', async () => {
    // Mock fetch to wait for the controller signal then throw AbortError.
    // We pass a tiny `timeout` so the per-attempt timer fires first; no
    // external signal is provided.
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      const sig: AbortSignal | undefined = init?.signal;
      return new Promise((_, reject) => {
        sig?.addEventListener('abort', () => {
          const err: Error & { name: string } = new Error('AbortError');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
    }) as any;

    // No external signal — only the per-attempt timer can fire.
    const ctx: any = {
      publisher: null,
      state: { userId: 'u-timeout' },
      runId: 'r-timeout',
      nodeId: 'n-timeout',
      toolId: 't-timeout',
      // abortSignal omitted intentionally
    };

    const result = await fetchUrlTool.handler(
      { url: 'http://test.invalid/path', timeout: 60 },
      ctx,
    );

    expect((result as any).isError).toBe(true);
    const text = (result as any).content?.[0]?.text || '';
    const parsed = JSON.parse(text);
    expect(parsed.error).toMatch(/timed out after 60ms/);
    expect(parsed.error).not.toMatch(/aborted by caller/);
  });

  test('reports "aborted" when external signal is pre-aborted (short-circuits before fetch)', async () => {
    const controller = new AbortController();
    controller.abort('test-pre-aborted');
    const ctx = buildContext(controller.signal);

    const result = await fetchUrlTool.handler(
      { url: 'http://test.invalid/path', timeout: 300_000 },
      ctx,
    );

    expect((result as any).isError).toBe(true);
    const text = (result as any).content?.[0]?.text || '';
    const parsed = JSON.parse(text);
    // The pre-aborted check throws "fetch_url aborted before send" which is
    // caught by the outer catch — and since runAbortSignal.aborted is true at
    // that point, we report "aborted by caller".
    expect(parsed.error).toMatch(/aborted/);
    expect(parsed.error).not.toMatch(/timed out/);
  });
});
