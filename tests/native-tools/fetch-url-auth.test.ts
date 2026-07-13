/**
 * fetch_url — run-owner auth attachment
 *
 * Confirms that fetch_url transparently authenticates requests to allowlisted
 * internal redbtn hosts as the run owner, and — critically — leaks NO
 * credentials to any other host.
 *
 * The non-allowlisted assertions are a security boundary: a regression here
 * would forward the run owner's session token to a third-party server.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fetchUrlTool from '../../src/lib/tools/native/fetch-url';

function ctx(state: Record<string, unknown> = {}): any {
  return {
    publisher: null,
    state,
    runId: 'r-fetch-url-auth',
    nodeId: 'n-fetch-url-auth',
    toolId: 't-fetch-url-auth',
    abortSignal: null,
  };
}

function headerKeysLower(h: Record<string, string>): string[] {
  return Object.keys(h).map(k => k.toLowerCase());
}

describe('fetch_url — run-owner auth attachment', () => {
  let originalFetch: typeof globalThis.fetch;
  let captured: { url: string; headers: Record<string, string>; redirect?: string }[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    captured = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      captured.push({ url: String(url), headers: { ...(init?.headers || {}) }, redirect: init?.redirect });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.INTERNAL_SERVICE_KEY;
    vi.restoreAllMocks();
  });

  test('attaches Bearer + X-User-Id to an allowlisted internal host', async () => {
    await fetchUrlTool.handler(
      { url: 'https://app.redbtn.io/api/auth/me' },
      ctx({ authToken: 'jwt-abc', userId: 'user-1' }),
    );
    const h = captured[0].headers;
    expect(h['Authorization']).toBe('Bearer jwt-abc');
    expect(h['X-User-Id']).toBe('user-1');
  });

  test('attaches credentials to run.redbtn.io as well', async () => {
    await fetchUrlTool.handler(
      { url: 'https://run.redbtn.io/api/workspaces' },
      ctx({ authToken: 'jwt-run', userId: 'user-2' }),
    );
    expect(captured[0].headers['Authorization']).toBe('Bearer jwt-run');
    expect(captured[0].headers['X-User-Id']).toBe('user-2');
  });

  test('attaches NO credentials to a non-allowlisted external host', async () => {
    await fetchUrlTool.handler(
      { url: 'https://evil.example.com/x' },
      ctx({ authToken: 'jwt-abc', userId: 'user-1' }),
    );
    const keys = headerKeysLower(captured[0].headers);
    expect(keys).not.toContain('authorization');
    expect(keys).not.toContain('x-user-id');
    expect(keys).not.toContain('x-internal-key');
    expect(keys).not.toContain('cookie');
  });

  test('attaches NO credentials to a look-alike host', async () => {
    await fetchUrlTool.handler(
      { url: 'https://app.redbtn.io.evil.com/x' },
      ctx({ authToken: 'jwt-abc', userId: 'user-1' }),
    );
    const keys = headerKeysLower(captured[0].headers);
    expect(keys).not.toContain('authorization');
    expect(keys).not.toContain('x-user-id');
  });

  test('does not overwrite a caller-supplied Authorization header', async () => {
    await fetchUrlTool.handler(
      {
        url: 'https://app.redbtn.io/x',
        headers: { Authorization: 'Bearer caller-token' },
      },
      ctx({ authToken: 'jwt-abc', userId: 'user-1' }),
    );
    expect(captured[0].headers['Authorization']).toBe('Bearer caller-token');
  });

  test('does not overwrite a caller-supplied lowercase authorization header', async () => {
    await fetchUrlTool.handler(
      {
        url: 'https://app.redbtn.io/x',
        headers: { authorization: 'Bearer caller-lower' },
      },
      ctx({ authToken: 'jwt-abc', userId: 'user-1' }),
    );
    const h = captured[0].headers;
    expect(h['authorization']).toBe('Bearer caller-lower');
    expect(h['Authorization']).toBeUndefined();
  });

  test('attaches X-Internal-Key when env INTERNAL_SERVICE_KEY is set', async () => {
    process.env.INTERNAL_SERVICE_KEY = 'svc-key';
    await fetchUrlTool.handler(
      { url: 'https://run.redbtn.io/x' },
      ctx({ userId: 'user-1' }),
    );
    expect(captured[0].headers['X-Internal-Key']).toBe('svc-key');
  });

  test('does not leak X-Internal-Key to a non-allowlisted host', async () => {
    process.env.INTERNAL_SERVICE_KEY = 'svc-key';
    await fetchUrlTool.handler(
      { url: 'https://evil.example.com/x' },
      ctx({ userId: 'user-1' }),
    );
    expect(headerKeysLower(captured[0].headers)).not.toContain('x-internal-key');
  });

  test('attaches credentials to the configured WEBAPP_URL host', async () => {
    const prev = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = 'https://my-webapp.example.net';
    try {
      await fetchUrlTool.handler(
        { url: 'https://my-webapp.example.net/api/auth/me' },
        ctx({ authToken: 'jwt-web', userId: 'user-3' }),
      );
      expect(captured[0].headers['Authorization']).toBe('Bearer jwt-web');
      expect(captured[0].headers['X-User-Id']).toBe('user-3');
    } finally {
      if (prev === undefined) delete process.env.WEBAPP_URL;
      else process.env.WEBAPP_URL = prev;
    }
  });

  test('forces manual redirect handling when internal credentials are attached, even with followRedirects unset (default true)', async () => {
    // Regression: fetch() auto-follows redirects and forwards plain headers
    // like X-User-Id/X-Internal-Key on cross-origin hops (Authorization is
    // spec-stripped, these are not) — verified empirically against Node's
    // fetch. If app.redbtn.io/run.redbtn.io/WEBAPP_URL ever has an
    // open-redirect endpoint, auto-following would leak the run owner's
    // identity and the shared internal service key to the redirect target.
    process.env.INTERNAL_SERVICE_KEY = 'svc-key';
    await fetchUrlTool.handler(
      { url: 'https://app.redbtn.io/api/something' },
      ctx({ authToken: 'jwt-abc', userId: 'user-1' }),
    );
    expect(captured[0].redirect).toBe('manual');
  });

  test('forces manual redirect handling when internal credentials are attached, even with followRedirects: true explicitly', async () => {
    process.env.INTERNAL_SERVICE_KEY = 'svc-key';
    await fetchUrlTool.handler(
      { url: 'https://run.redbtn.io/api/workspaces', followRedirects: true },
      ctx({ authToken: 'jwt-run', userId: 'user-2' }),
    );
    expect(captured[0].redirect).toBe('manual');
  });

  test('a non-internal host still auto-follows redirects by default (behavior unchanged)', async () => {
    await fetchUrlTool.handler(
      { url: 'https://example.com/x' },
      ctx({ authToken: 'jwt-abc', userId: 'user-1' }),
    );
    expect(captured[0].redirect).toBe('follow');
  });

  test('a public internal endpoint with no run credentials still auto-follows (no auth was attached)', async () => {
    const res = await fetchUrlTool.handler(
      { url: 'https://app.redbtn.io/health' },
      ctx({}),
    );
    expect(captured[0].redirect).toBe('follow');
    expect(res.isError).not.toBe(true);
  });

  test('a public internal endpoint with no run credentials still succeeds', async () => {
    const res = await fetchUrlTool.handler(
      { url: 'https://app.redbtn.io/health' },
      ctx({}),
    );
    const keys = headerKeysLower(captured[0].headers);
    expect(keys).not.toContain('authorization');
    expect(keys).not.toContain('x-user-id');
    expect(res.isError).not.toBe(true);
    const payload = JSON.parse((res.content[0] as any).text);
    expect(payload.status).toBe(200);
  });
});
