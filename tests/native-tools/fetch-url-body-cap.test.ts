/**
 * fetch_url — response body size cap
 *
 * Regression: fetch_url used to buffer the ENTIRE response body into memory
 * via `response.text()` before any size check ran — the 500,000-character
 * truncation only applied to the already-fully-buffered string. Since
 * fetch_url targets an arbitrary caller-supplied URL, an oversized (or
 * maliciously large) upstream response was an unbounded memory-exhaustion
 * vector, unlike download-file.ts, which streams the body and aborts
 * mid-stream once a cap is exceeded.
 *
 * These tests mock a Response whose body ReadableStream yields far more than
 * MAX_RESPONSE_BODY_BYTES and assert the reader is cancelled early (proven by
 * a read-count ceiling) rather than drained to completion.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fetchUrlTool from '../../src/lib/tools/native/fetch-url';

function ctx(): any {
  return {
    publisher: null,
    state: {},
    runId: 'r-fetch-url-body-cap',
    nodeId: 'n-fetch-url-body-cap',
    toolId: 't-fetch-url-body-cap',
    abortSignal: null,
  };
}

// One 1 MB chunk, reused so we don't hold multiple huge buffers in the test
// process itself.
const CHUNK = new Uint8Array(1024 * 1024).fill(97); // 'a' repeated

describe('fetch_url — response body cap', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('cancels the body stream once MAX_RESPONSE_BODY_BYTES is exceeded, instead of draining a huge body fully', async () => {
    let chunksServed = 0;
    let cancelled = false;
    const TOTAL_CHUNKS = 100; // 100 MB if fully drained — must never happen

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksServed >= TOTAL_CHUNKS) {
          controller.close();
          return;
        }
        chunksServed += 1;
        controller.enqueue(CHUNK);
      },
      cancel() {
        cancelled = true;
      },
    });

    globalThis.fetch = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await fetchUrlTool.handler({ url: 'https://example.com/huge' }, ctx());

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    // 8 MB cap / 1 MB chunks — capped well short of the 100 MB the mock could
    // have served, proving the stream was abandoned early, not drained. Allow
    // a little slack for the stream's internal read-ahead buffering.
    expect(chunksServed).toBeLessThan(TOTAL_CHUNKS);
    expect(chunksServed).toBeLessThanOrEqual(12);
    expect(cancelled).toBe(true);
    expect(parsed.body).toContain('truncated');
  });

  test('a normal small response is returned intact, uncapped', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ hello: 'world' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await fetchUrlTool.handler({ url: 'https://example.com/small' }, ctx());

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(JSON.parse(parsed.body)).toEqual({ hello: 'world' });
  });
});
