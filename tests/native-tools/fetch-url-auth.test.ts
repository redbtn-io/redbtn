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
  let captured: { url: string; headers: Record<string, string> }[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    captured = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      captured.push({ url: String(url), headers: { ...(init?.headers || {}) } });
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

  // RETRACTED, deliberately. These two used to assert that a caller-supplied
  // `Authorization` WINS over the run's own on an internal host ("does not
  // overwrite a caller-supplied Authorization header"). Round 3 of the review
  // of PR #378 (§3b) showed why that is a hole: an authored step with a LITERAL
  // internal URL is trusted with the destination, correctly — but the same
  // merge let the model choose `X-User-Id` while `X-Internal-Key` still went
  // out, which on the webapp side is ADMIN impersonating that user id. The rule
  // is now: on an internal host the three identity headers are ALWAYS the
  // run's, and a caller-supplied copy is dropped. See
  // tests/security/internal-auth-header-override.test.ts.
  test('a caller-supplied Authorization does NOT survive on an internal host', async () => {
    await fetchUrlTool.handler(
      {
        url: 'https://app.redbtn.io/x',
        headers: { Authorization: 'Bearer caller-token' },
      },
      ctx({ authToken: 'jwt-abc', userId: 'user-1' }),
    );
    expect(captured[0].headers['Authorization']).toBe('Bearer jwt-abc');
  });

  test('a lowercase authorization header is dropped too — casing is not a bypass', async () => {
    await fetchUrlTool.handler(
      {
        url: 'https://app.redbtn.io/x',
        headers: { authorization: 'Bearer caller-lower' },
      },
      ctx({ authToken: 'jwt-abc', userId: 'user-1' }),
    );
    const h = captured[0].headers;
    expect(h['authorization']).toBeUndefined();
    expect(h['Authorization']).toBe('Bearer jwt-abc');
  });

  test('a caller-supplied Authorization to a THIRD-PARTY host is untouched', async () => {
    // The control: only the platform's own hosts are special, and only because
    // the platform trusts those headers there.
    await fetchUrlTool.handler(
      {
        url: 'https://partner.example.com/x',
        headers: { Authorization: 'Bearer caller-token' },
      },
      ctx({ authToken: 'jwt-abc', userId: 'user-1' }),
    );
    expect(captured[0].headers['Authorization']).toBe('Bearer caller-token');
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
