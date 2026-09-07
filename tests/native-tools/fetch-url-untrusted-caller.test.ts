/**
 * fetch_url — internal-auth suppression for untrusted callers, and the SSRF guard.
 *
 * # The hole this covers
 *
 * `fetch_url` attaches the run's `Authorization`, `X-User-Id` and the
 * platform's `X-Internal-Key` when the target host is on the internal
 * allowlist. On the webapp side `X-Internal-Key` + `X-User-Id` resolves as an
 * ADMIN request impersonating that user. Because the URL is chosen by the
 * model in the neuron tool-use loop, a prompt-injected run could point
 * `fetch_url` at any internal API and act as the run's owner with the
 * platform's service key.
 *
 * The fix is `NativeToolContext.untrustedCaller`: the neuron loop sets it, and
 * with it set NO credential header is ever attached — allowlisted host or not.
 * Independently, every URL (trusted or not) must resolve to a public address,
 * on the first request and on each redirect hop.
 *
 * A regression in either assertion re-opens a privilege escalation, so these
 * tests are a security boundary, not a convenience.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fetchUrlTool from '../../src/lib/tools/native/fetch-url';
import { __setSsrfLookupForTests } from '../../src/lib/net/ssrf-guard';

function ctx(overrides: Record<string, unknown> = {}): any {
  return {
    publisher: null,
    state: { authToken: 'jwt-abc', userId: 'user-1' },
    runId: 'r-untrusted',
    nodeId: 'n-untrusted',
    toolId: 't-untrusted',
    abortSignal: null,
    ...overrides,
  };
}

function headerKeysLower(h: Record<string, string>): string[] {
  return Object.keys(h).map((k) => k.toLowerCase());
}

describe('fetch_url — internal auth is suppressed for untrusted callers', () => {
  let originalFetch: typeof globalThis.fetch;
  let captured: { url: string; headers: Record<string, string> }[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    captured = [];
    process.env.INTERNAL_SERVICE_KEY = 'svc-key';
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
    __setSsrfLookupForTests(null);
    vi.restoreAllMocks();
  });

  test('attaches nothing to an allowlisted internal host when untrustedCaller is set', async () => {
    await fetchUrlTool.handler(
      { url: 'https://app.redbtn.io/api/graphs' },
      ctx({ untrustedCaller: true }),
    );
    const keys = headerKeysLower(captured[0].headers);
    expect(keys).not.toContain('authorization');
    expect(keys).not.toContain('x-user-id');
    expect(keys).not.toContain('x-internal-key');
  });

  test('suppression also covers run.redbtn.io and the configured WEBAPP_URL host', async () => {
    const prev = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = 'https://my-webapp.example.net';
    try {
      for (const url of [
        'https://run.redbtn.io/api/workspaces',
        'https://my-webapp.example.net/api/auth/me',
      ]) {
        captured = [];
        await fetchUrlTool.handler({ url }, ctx({ untrustedCaller: true }));
        const keys = headerKeysLower(captured[0].headers);
        expect(keys).not.toContain('authorization');
        expect(keys).not.toContain('x-user-id');
        expect(keys).not.toContain('x-internal-key');
      }
    } finally {
      if (prev === undefined) delete process.env.WEBAPP_URL;
      else process.env.WEBAPP_URL = prev;
    }
  });

  test('a trusted caller (graph tool step) keeps the existing behaviour', async () => {
    await fetchUrlTool.handler({ url: 'https://app.redbtn.io/api/graphs' }, ctx());
    const h = captured[0].headers;
    expect(h['Authorization']).toBe('Bearer jwt-abc');
    expect(h['X-User-Id']).toBe('user-1');
    expect(h['X-Internal-Key']).toBe('svc-key');
  });

  test('untrustedCaller: false is treated as trusted (explicit opt-in stays possible)', async () => {
    await fetchUrlTool.handler(
      { url: 'https://app.redbtn.io/api/graphs' },
      ctx({ untrustedCaller: false }),
    );
    expect(captured[0].headers['X-Internal-Key']).toBe('svc-key');
  });

  test('an untrusted caller can still fetch a public URL normally', async () => {
    const res = await fetchUrlTool.handler(
      { url: 'https://example.com/docs' },
      ctx({ untrustedCaller: true }),
    );
    expect(res.isError).not.toBe(true);
    expect(JSON.parse((res.content[0] as any).text).status).toBe(200);
  });
});

describe('fetch_url — SSRF guard applies to every caller', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __setSsrfLookupForTests(null);
    vi.restoreAllMocks();
  });

  test.each([
    ['http://10.100.0.10:9000/minio'],
    ['http://172.17.0.1/x'],
    ['http://192.168.1.10/x'],
    ['http://127.0.0.1:3000/api/auth/me'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://[::1]:3000/x'],
    ['http://[fd00::1]/x'],
  ])('refuses %s and never dials it', async (url) => {
    const res = await fetchUrlTool.handler({ url }, ctx({ untrustedCaller: true }));
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as any).text).code).toBe('BLOCKED_PRIVATE_ADDRESS');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('refuses a private target for a TRUSTED caller too', async () => {
    const res = await fetchUrlTool.handler({ url: 'http://10.100.0.10:9000/minio' }, ctx());
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as any).text).code).toBe('BLOCKED_PRIVATE_ADDRESS');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('refuses a hostname that resolves into the fleet network', async () => {
    __setSsrfLookupForTests(async () => [{ address: '10.100.0.10', family: 4 }]);
    const res = await fetchUrlTool.handler(
      { url: 'https://looks-public.example.com/x' },
      ctx({ untrustedCaller: true }),
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as any).text).code).toBe('BLOCKED_PRIVATE_ADDRESS');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('fetch_url — redirect hops are re-checked', () => {
  let originalFetch: typeof globalThis.fetch;
  let requested: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requested = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __setSsrfLookupForTests(null);
    vi.restoreAllMocks();
  });

  test('a public URL that 302s into the private network is blocked at the hop', async () => {
    __setSsrfLookupForTests(async (host) =>
      host === 'inside.example.com'
        ? [{ address: '10.100.0.10', family: 4 }]
        : [{ address: '203.0.113.10', family: 4 }],
    );
    globalThis.fetch = vi.fn(async (u: any) => {
      requested.push(String(u));
      if (String(u) === 'https://public.example.com/go') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://inside.example.com/secrets' },
        });
      }
      return new Response('reached', { status: 200 });
    }) as any;

    const res = await fetchUrlTool.handler(
      { url: 'https://public.example.com/go' },
      ctx({ untrustedCaller: true }),
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as any).text).code).toBe('BLOCKED_PRIVATE_ADDRESS');
    expect(requested).toEqual(['https://public.example.com/go']);
  });

  test('a redirect to a literal loopback address is blocked', async () => {
    __setSsrfLookupForTests(async () => [{ address: '203.0.113.10', family: 4 }]);
    globalThis.fetch = vi.fn(async (u: any) => {
      requested.push(String(u));
      return new Response(null, {
        status: 301,
        headers: { location: 'http://127.0.0.1:3000/api/auth/me' },
      });
    }) as any;

    const res = await fetchUrlTool.handler(
      { url: 'https://public.example.com/go' },
      ctx({ untrustedCaller: true }),
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as any).text).code).toBe('BLOCKED_PRIVATE_ADDRESS');
    expect(requested).toEqual(['https://public.example.com/go']);
  });

  test('follows a public redirect chain and returns the final body', async () => {
    __setSsrfLookupForTests(async () => [{ address: '203.0.113.10', family: 4 }]);
    globalThis.fetch = vi.fn(async (u: any) => {
      requested.push(String(u));
      if (String(u) === 'https://a.example.com/1') {
        return new Response(null, { status: 302, headers: { location: 'https://b.example.com/2' } });
      }
      return new Response(JSON.stringify({ landed: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    const res = await fetchUrlTool.handler(
      { url: 'https://a.example.com/1' },
      ctx({ untrustedCaller: true }),
    );
    expect(res.isError).not.toBe(true);
    const payload = JSON.parse((res.content[0] as any).text);
    expect(payload.status).toBe(200);
    expect(payload.body).toContain('landed');
    expect(requested).toEqual(['https://a.example.com/1', 'https://b.example.com/2']);
  });

  test('stops after 5 hops instead of chasing a redirect loop', async () => {
    __setSsrfLookupForTests(async () => [{ address: '203.0.113.10', family: 4 }]);
    globalThis.fetch = vi.fn(async (u: any) => {
      requested.push(String(u));
      const n = Number(String(u).split('/').pop());
      return new Response(null, {
        status: 302,
        headers: { location: `https://loop.example.com/${n + 1}` },
      });
    }) as any;

    const res = await fetchUrlTool.handler(
      { url: 'https://loop.example.com/0' },
      ctx({ untrustedCaller: true }),
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as any).text).code).toBe('BLOCKED_TOO_MANY_REDIRECTS');
    expect(requested.length).toBe(6);
  });

  test('a credentialed internal request still refuses to follow its redirect', async () => {
    process.env.INTERNAL_SERVICE_KEY = 'svc-key';
    __setSsrfLookupForTests(async () => [{ address: '203.0.113.10', family: 4 }]);
    globalThis.fetch = vi.fn(async (u: any) => {
      requested.push(String(u));
      return new Response(null, {
        status: 302,
        headers: { location: 'https://elsewhere.example.com/' },
      });
    }) as any;

    try {
      const res = await fetchUrlTool.handler({ url: 'https://app.redbtn.io/api/x' }, ctx());
      expect(res.isError).not.toBe(true);
      expect(JSON.parse((res.content[0] as any).text).status).toBe(302);
      expect(requested).toEqual(['https://app.redbtn.io/api/x']);
    } finally {
      delete process.env.INTERNAL_SERVICE_KEY;
    }
  });

  test('caller-supplied credential headers are dropped on a cross-origin hop', async () => {
    __setSsrfLookupForTests(async () => [{ address: '203.0.113.10', family: 4 }]);
    const sent: Record<string, string>[] = [];
    globalThis.fetch = vi.fn(async (u: any, init: any) => {
      sent.push({ ...(init?.headers || {}) });
      if (String(u) === 'https://a.example.com/1') {
        return new Response(null, { status: 302, headers: { location: 'https://b.example.com/2' } });
      }
      return new Response('ok', { status: 200 });
    }) as any;

    await fetchUrlTool.handler(
      {
        url: 'https://a.example.com/1',
        headers: { Authorization: 'Bearer model-supplied', 'X-Trace': 'keep-me' },
      },
      ctx({ untrustedCaller: true }),
    );

    expect(sent[0]['Authorization']).toBe('Bearer model-supplied');
    expect(sent[1]['Authorization']).toBeUndefined();
    expect(sent[1]['X-Trace']).toBe('keep-me');
  });
});
