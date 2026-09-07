/**
 * SSRF guard — address classification, URL admission, redirect re-checking.
 *
 * The classification tests are pure: no DNS, no network, no mocks. The
 * admission and redirect tests drive the guard through its test seam
 * (`__setSsrfLookupForTests`) and a stubbed `globalThis.fetch`, so the whole
 * file is deterministic and offline.
 *
 * Why this matters: the engine runs inside the redbtn worker on the private
 * fleet network. Every tool that fetches a model-supplied URL goes through
 * this module; a regression here re-opens the worker as a proxy into
 * 10.0.0.0/8, 192.168.0.0/16 and localhost.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateAddress,
  parseIpv4,
  parseIpv6,
  assertPublicUrl,
  assertPublicRedirect,
  isRedirectStatus,
  safeFetch,
  SsrfBlockedError,
  MAX_REDIRECT_HOPS,
  __setSsrfLookupForTests,
} from '../../src/lib/net/ssrf-guard';

/** Install a resolver that maps every hostname to `address`. */
function lookupAlways(address: string, family = 4): void {
  __setSsrfLookupForTests(async () => [{ address, family }]);
}

describe('ssrf-guard — IPv4 classification (pure)', () => {
  test('rejects every private / loopback / link-local range named in the scope', () => {
    // 10.0.0.0/8 — the whole fleet LAN and the WireGuard mesh
    expect(isPrivateIpv4('10.0.0.0')).toBe(true);
    expect(isPrivateIpv4('10.100.0.10')).toBe(true);
    expect(isPrivateIpv4('10.255.255.255')).toBe(true);
    // 172.16.0.0/12 — Docker bridge pools
    expect(isPrivateIpv4('172.16.0.1')).toBe(true);
    expect(isPrivateIpv4('172.20.10.5')).toBe(true);
    expect(isPrivateIpv4('172.31.255.255')).toBe(true);
    // 192.168.0.0/16 — the 192.168.1.x fleet LAN
    expect(isPrivateIpv4('192.168.0.1')).toBe(true);
    expect(isPrivateIpv4('192.168.1.10')).toBe(true);
    expect(isPrivateIpv4('192.168.255.255')).toBe(true);
    // 127.0.0.0/8 — loopback
    expect(isPrivateIpv4('127.0.0.1')).toBe(true);
    expect(isPrivateIpv4('127.255.255.254')).toBe(true);
    // 169.254.0.0/16 — link-local, including cloud metadata
    expect(isPrivateIpv4('169.254.0.1')).toBe(true);
    expect(isPrivateIpv4('169.254.169.254')).toBe(true);
  });

  test('rejects the documented additional ranges', () => {
    expect(isPrivateIpv4('0.0.0.0')).toBe(true);          // reaches localhost on Linux
    expect(isPrivateIpv4('0.1.2.3')).toBe(true);          // 0.0.0.0/8
    expect(isPrivateIpv4('100.64.0.1')).toBe(true);       // CGNAT
    expect(isPrivateIpv4('100.127.255.255')).toBe(true);
    expect(isPrivateIpv4('224.0.0.1')).toBe(true);        // multicast
    expect(isPrivateIpv4('255.255.255.255')).toBe(true);  // broadcast (240/4)
  });

  test('allows addresses just outside each blocked range', () => {
    expect(isPrivateIpv4('9.255.255.255')).toBe(false);
    expect(isPrivateIpv4('11.0.0.1')).toBe(false);
    expect(isPrivateIpv4('172.15.255.255')).toBe(false);
    expect(isPrivateIpv4('172.32.0.1')).toBe(false);
    expect(isPrivateIpv4('192.167.255.255')).toBe(false);
    expect(isPrivateIpv4('192.169.0.1')).toBe(false);
    expect(isPrivateIpv4('126.255.255.255')).toBe(false);
    expect(isPrivateIpv4('128.0.0.1')).toBe(false);
    expect(isPrivateIpv4('169.253.255.255')).toBe(false);
    expect(isPrivateIpv4('169.255.0.1')).toBe(false);
    expect(isPrivateIpv4('100.63.255.255')).toBe(false);
    expect(isPrivateIpv4('100.128.0.1')).toBe(false);
    expect(isPrivateIpv4('223.255.255.255')).toBe(false);
  });

  test('allows ordinary public addresses', () => {
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
    expect(isPrivateIpv4('1.1.1.1')).toBe(false);
    expect(isPrivateIpv4('203.0.113.10')).toBe(false);
  });

  test('parseIpv4 rejects malformed and non-decimal forms', () => {
    expect(parseIpv4('1.2.3')).toBeNull();
    expect(parseIpv4('1.2.3.4.5')).toBeNull();
    expect(parseIpv4('256.1.1.1')).toBeNull();
    expect(parseIpv4('01.2.3.4')).toBeNull();
    expect(parseIpv4('0x7f.0.0.1')).toBeNull();
    expect(parseIpv4('')).toBeNull();
    expect(parseIpv4('10.0.0.1')).toEqual([10, 0, 0, 1]);
  });
});

describe('ssrf-guard — IPv6 classification (pure)', () => {
  test('rejects loopback, unspecified, unique-local and link-local', () => {
    expect(isPrivateIpv6('::1')).toBe(true);
    expect(isPrivateIpv6('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isPrivateIpv6('::')).toBe(true);
    expect(isPrivateIpv6('fc00::1')).toBe(true);
    expect(isPrivateIpv6('fd12:3456:789a::1')).toBe(true);
    expect(isPrivateIpv6('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
    expect(isPrivateIpv6('fe80::1')).toBe(true);
    expect(isPrivateIpv6('fe80::1%eth0')).toBe(true);
    expect(isPrivateIpv6('febf::1')).toBe(true);
  });

  test('re-checks IPv4-mapped and IPv4-compatible forms as IPv4', () => {
    expect(isPrivateIpv6('::ffff:10.100.0.10')).toBe(true);
    expect(isPrivateIpv6('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIpv6('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIpv6('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIpv6('::192.168.1.10')).toBe(true);
  });

  test('allows public IPv6', () => {
    expect(isPrivateIpv6('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIpv6('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateIpv6('fec0::1')).toBe(false); // deprecated site-local, not in fe80::/10
  });

  test('parseIpv6 expands compression and embedded IPv4 to eight groups', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('::ffff:10.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]);
    expect(parseIpv6('2001:db8::1')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6('1:2:3:4:5:6:7')).toBeNull();       // too few without '::'
    expect(parseIpv6('1::2::3')).toBeNull();             // two '::'
    expect(parseIpv6('gggg::1')).toBeNull();
  });

  test('isPrivateAddress dispatches on family and tolerates brackets', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('[::1]')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('not-an-ip')).toBe(false);
    expect(isPrivateAddress('')).toBe(false);
  });
});

describe('ssrf-guard — assertPublicUrl', () => {
  afterEach(() => {
    __setSsrfLookupForTests(null);
  });

  test('refuses a literal private address without any DNS lookup', async () => {
    const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    __setSsrfLookupForTests(lookup);
    await expect(assertPublicUrl('http://10.100.0.10:9000/x')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(lookup).not.toHaveBeenCalled();
  });

  test.each([
    ['http://10.0.0.5/x'],
    ['http://172.16.4.4/x'],
    ['http://192.168.1.10/x'],
    ['http://127.0.0.1:3000/api/auth/me'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://[::1]:3000/x'],
    ['http://[fc00::1]/x'],
    ['http://[fe80::1]/x'],
    ['http://[::ffff:10.100.0.10]/x'],
  ])('refuses %s', async (url) => {
    await expect(assertPublicUrl(url)).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      code: 'BLOCKED_PRIVATE_ADDRESS',
    });
  });

  test('refuses a hostname that resolves to a private address', async () => {
    lookupAlways('192.168.1.10');
    await expect(assertPublicUrl('https://internal.example.com/x')).rejects.toMatchObject({
      code: 'BLOCKED_PRIVATE_ADDRESS',
      host: 'internal.example.com',
      address: '192.168.1.10',
    });
  });

  test('fails closed when ANY resolved address is private', async () => {
    __setSsrfLookupForTests(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.100.0.10', family: 4 },
    ]);
    await expect(assertPublicUrl('https://rebind.example.com/x')).rejects.toMatchObject({
      code: 'BLOCKED_PRIVATE_ADDRESS',
      address: '10.100.0.10',
    });
  });

  test('allows a hostname that resolves only to public addresses', async () => {
    __setSsrfLookupForTests(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    await expect(assertPublicUrl('https://example.com/x')).resolves.toEqual([
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]);
  });

  test('refuses a non-http scheme', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toMatchObject({ code: 'BLOCKED_SCHEME' });
    await expect(assertPublicUrl('gopher://example.com/')).rejects.toMatchObject({ code: 'BLOCKED_SCHEME' });
  });

  test('refuses an unparseable URL and an unresolvable host', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toMatchObject({ code: 'BLOCKED_INVALID_URL' });
    __setSsrfLookupForTests(async () => {
      throw new Error('getaddrinfo ENOTFOUND nope.invalid');
    });
    await expect(assertPublicUrl('https://nope.invalid/x')).rejects.toMatchObject({
      code: 'BLOCKED_UNRESOLVABLE',
    });
    __setSsrfLookupForTests(async () => []);
    await expect(assertPublicUrl('https://empty.example.com/x')).rejects.toMatchObject({
      code: 'BLOCKED_UNRESOLVABLE',
    });
  });
});

describe('ssrf-guard — assertPublicRedirect', () => {
  afterEach(() => {
    __setSsrfLookupForTests(null);
  });

  test('resolves a relative Location against the current URL', async () => {
    lookupAlways('93.184.216.34');
    await expect(assertPublicRedirect('https://example.com/a/b', '../c')).resolves.toBe(
      'https://example.com/c',
    );
  });

  test('refuses a redirect into the private network', async () => {
    lookupAlways('93.184.216.34');
    await expect(
      assertPublicRedirect('https://example.com/a', 'http://10.100.0.10:9000/secret'),
    ).rejects.toMatchObject({ code: 'BLOCKED_PRIVATE_ADDRESS' });
  });
});

describe('ssrf-guard — safeFetch', () => {
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

  test('always asks fetch for manual redirects so each hop can be re-checked', async () => {
    lookupAlways('93.184.216.34');
    let seenRedirect: string | undefined;
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      seenRedirect = init?.redirect;
      return new Response('ok', { status: 200 });
    }) as any;

    await safeFetch('https://example.com/x');
    expect(seenRedirect).toBe('manual');
  });

  test('follows a public redirect chain and re-checks every hop', async () => {
    const seen: string[] = [];
    __setSsrfLookupForTests(async (host) => {
      seen.push(host);
      return [{ address: '93.184.216.34', family: 4 }];
    });
    globalThis.fetch = vi.fn(async (u: any) => {
      requested.push(String(u));
      if (String(u) === 'https://a.example.com/1') {
        return new Response(null, { status: 302, headers: { location: 'https://b.example.com/2' } });
      }
      return new Response('landed', { status: 200 });
    }) as any;

    const res = await safeFetch('https://a.example.com/1');
    expect(res.status).toBe(200);
    expect(requested).toEqual(['https://a.example.com/1', 'https://b.example.com/2']);
    expect(seen).toEqual(['a.example.com', 'b.example.com']);
  });

  test('refuses a redirect whose target resolves into the private network', async () => {
    __setSsrfLookupForTests(async (host) =>
      host === 'evil.example.com'
        ? [{ address: '10.100.0.10', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }],
    );
    globalThis.fetch = vi.fn(async (u: any) => {
      requested.push(String(u));
      if (String(u) === 'https://start.example.com/1') {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } });
      }
      return new Response('should never be reached', { status: 200 });
    }) as any;

    await expect(safeFetch('https://start.example.com/1')).rejects.toMatchObject({
      code: 'BLOCKED_PRIVATE_ADDRESS',
    });
    // The second hop must never have been dialled.
    expect(requested).toEqual(['https://start.example.com/1']);
  });

  test('refuses a redirect straight to a literal private address', async () => {
    lookupAlways('93.184.216.34');
    globalThis.fetch = vi.fn(async (u: any) => {
      requested.push(String(u));
      return new Response(null, { status: 301, headers: { location: 'http://127.0.0.1:3000/api' } });
    }) as any;

    await expect(safeFetch('https://start.example.com/1')).rejects.toMatchObject({
      code: 'BLOCKED_PRIVATE_ADDRESS',
      address: '127.0.0.1',
    });
    expect(requested).toEqual(['https://start.example.com/1']);
  });

  test(`stops after ${MAX_REDIRECT_HOPS} hops`, async () => {
    lookupAlways('93.184.216.34');
    globalThis.fetch = vi.fn(async (u: any) => {
      requested.push(String(u));
      const n = Number(String(u).split('/').pop());
      return new Response(null, {
        status: 302,
        headers: { location: `https://loop.example.com/${n + 1}` },
      });
    }) as any;

    await expect(safeFetch('https://loop.example.com/0')).rejects.toMatchObject({
      code: 'BLOCKED_TOO_MANY_REDIRECTS',
    });
    expect(requested.length).toBe(MAX_REDIRECT_HOPS + 1);
  });

  test('drops credential headers when a redirect changes origin', async () => {
    lookupAlways('93.184.216.34');
    const sent: Record<string, string>[] = [];
    globalThis.fetch = vi.fn(async (u: any, init: any) => {
      sent.push({ ...(init?.headers || {}) });
      if (String(u) === 'https://a.example.com/1') {
        return new Response(null, { status: 302, headers: { location: 'https://b.example.com/2' } });
      }
      return new Response('ok', { status: 200 });
    }) as any;

    await safeFetch('https://a.example.com/1', {
      headers: { Authorization: 'Bearer secret', Cookie: 'sid=1', 'X-Trace': 'keep-me' },
    });

    expect(sent[0]['Authorization']).toBe('Bearer secret');
    expect(sent[1]['Authorization']).toBeUndefined();
    expect(sent[1]['Cookie']).toBeUndefined();
    expect(sent[1]['X-Trace']).toBe('keep-me');
  });

  test('returns the 3xx untouched when followRedirects is false', async () => {
    lookupAlways('93.184.216.34');
    globalThis.fetch = vi.fn(async (u: any) => {
      requested.push(String(u));
      return new Response(null, { status: 302, headers: { location: 'https://b.example.com/2' } });
    }) as any;

    const res = await safeFetch('https://a.example.com/1', {}, { followRedirects: false });
    expect(res.status).toBe(302);
    expect(requested).toEqual(['https://a.example.com/1']);
  });

  test('refuses the very first URL when it is private', async () => {
    globalThis.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as any;
    await expect(safeFetch('http://192.168.1.10/x')).rejects.toMatchObject({
      code: 'BLOCKED_PRIVATE_ADDRESS',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('ssrf-guard — isRedirectStatus', () => {
  test('covers exactly the Location-bearing statuses', () => {
    for (const s of [301, 302, 303, 307, 308]) expect(isRedirectStatus(s)).toBe(true);
    for (const s of [200, 204, 300, 304, 400, 404, 500]) expect(isRedirectStatus(s)).toBe(false);
  });
});
