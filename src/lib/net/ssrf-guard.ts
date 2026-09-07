/**
 * SSRF guard — outbound HTTP safety for model-supplied URLs.
 *
 * # Why this exists
 *
 * Several native tools fetch a URL the *model* chose (`fetch_url`, `scrape_url`,
 * `ssh_copy(sourceUrl)`, and the pages `web_search` scrapes when
 * `extractContent` is on). The engine runs inside the redbtn worker, which sits
 * on the private fleet network: without a guard, a prompt-injected run can point
 * any of those tools at `http://10.100.0.x/...`, `http://127.0.0.1:<port>/...`
 * or `http://169.254.169.254/...` and use the worker as a proxy into the private
 * network from the outside.
 *
 * This module is the single chokepoint that stops that:
 *
 *   - {@link assertPublicUrl} resolves the URL's hostname with
 *     `dns.lookup(host, { all: true })` and rejects when **any** returned
 *     address falls in a private / loopback / link-local range. "Any", not
 *     "all": a hostname that resolves to one public and one private address is
 *     rejected, so an attacker cannot hide an internal A record behind a public
 *     one.
 *   - {@link safeFetch} follows redirects **manually** and re-runs the check on
 *     every hop (max {@link MAX_REDIRECT_HOPS}), because `redirect: 'follow'`
 *     inside `fetch` re-resolves and re-connects without ever consulting us — a
 *     public URL that 302s to `http://10.100.0.10:9000` would otherwise sail
 *     straight through the front-door check.
 *
 * # Known residual risk (documented, not fixed here)
 *
 * DNS rebinding is a TOCTOU we do not close: we resolve the name, allow it, and
 * then `fetch` resolves the same name a second time and may get a different
 * answer. Closing that requires pinning the checked IP into the connection
 * (a custom undici dispatcher / `lookup` hook), which is a larger change than
 * this security patch. The guard still removes the entire class of *direct*
 * private-address and redirect-to-private attacks, which is what is reachable
 * from a prompt today.
 *
 * # Test seam
 *
 * {@link __setSsrfLookupForTests} swaps the resolver so unit tests are
 * deterministic and offline. Production code never calls it.
 *
 * @module lib/net/ssrf-guard
 */

import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';

/** Maximum number of redirect hops {@link safeFetch} will follow. */
export const MAX_REDIRECT_HOPS = 5;

/**
 * Request headers that must never survive a cross-origin redirect. Lowercased;
 * comparison is case-insensitive.
 */
const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'x-user-id',
  'x-internal-key',
  'proxy-authorization',
];

/**
 * Error thrown when a URL is refused. Carries machine-readable detail so
 * callers can render a clear, non-leaky message to the model.
 */
export class SsrfBlockedError extends Error {
  /** Stable machine code for the refusal reason. */
  public readonly code:
    | 'BLOCKED_PRIVATE_ADDRESS'
    | 'BLOCKED_SCHEME'
    | 'BLOCKED_UNRESOLVABLE'
    | 'BLOCKED_INVALID_URL'
    | 'BLOCKED_TOO_MANY_REDIRECTS';
  /** The URL that was refused. */
  public readonly url: string;
  /** The hostname that was refused, when one could be parsed. */
  public readonly host?: string;
  /** The offending resolved address, when the refusal was address-based. */
  public readonly address?: string;

  constructor(
    code: SsrfBlockedError['code'],
    message: string,
    url: string,
    host?: string,
    address?: string,
  ) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.code = code;
    this.url = url;
    this.host = host;
    this.address = address;
  }
}

// ===========================================================================
// Pure address classification (no network, no DNS — unit-testable in isolation)
// ===========================================================================

/**
 * Parse a dotted-quad IPv4 literal into its four octets.
 * Strict: exactly four decimal groups, each 0-255, no leading zeros beyond a
 * single `0`, no octal/hex forms (Node's `isIP` rejects those too, and every
 * address we classify has already been produced by `isIP` or by `dns.lookup`).
 */
export function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === '0') return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

/**
 * True when an IPv4 address is one the engine must never reach.
 *
 * Blocked (the set named in the security scope):
 *   - `10.0.0.0/8`      private (the whole redbtn fleet LAN + WireGuard mesh)
 *   - `172.16.0.0/12`   private (Docker's default bridge pools)
 *   - `192.168.0.0/16`  private (the 192.168.1.x fleet LAN)
 *   - `127.0.0.0/8`     loopback (every service bound to localhost on the worker)
 *   - `169.254.0.0/16`  link-local, which includes cloud metadata 169.254.169.254
 *
 * Blocked in addition (deliberate, documented widenings — each is either
 * unroutable or a well-known bypass of the list above):
 *   - `0.0.0.0/8`       "this network"; `0.0.0.0` reaches localhost on Linux
 *   - `100.64.0.0/10`   carrier-grade NAT / overlay-VPN shared space
 *   - `224.0.0.0/4`     multicast — meaningless as an HTTP target
 *   - `240.0.0.0/4`     reserved, and covers the 255.255.255.255 broadcast
 */
export function isPrivateIpv4(value: string): boolean {
  const o = parseIpv4(value);
  if (!o) return false;
  const [a, b] = o;
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 127) return true;                          // 127.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a >= 224) return true;                           // 224.0.0.0/4 + 240.0.0.0/4
  return false;
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups.
 * Handles `::` compression, an embedded trailing IPv4 (`::ffff:10.0.0.1`), and
 * a zone id (`fe80::1%eth0`). Returns null when the literal is malformed.
 */
export function parseIpv6(value: string): number[] | null {
  let text = value.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text) return null;

  // A trailing dotted-quad contributes the last two groups.
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = lastColon >= 0 ? text.slice(lastColon + 1) : '';
  if (maybeV4.indexOf('.') >= 0) {
    const octets = parseIpv4(maybeV4);
    if (!octets) return null;
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    text = text.slice(0, lastColon + 1) + '0';
  }

  const doubleColon = text.indexOf('::');
  if (doubleColon !== text.lastIndexOf('::')) return null; // more than one '::'

  const toGroups = (chunk: string): number[] | null => {
    if (!chunk) return [];
    const groups: number[] = [];
    for (const piece of chunk.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  let head: number[];
  let rest: number[];
  if (doubleColon >= 0) {
    const left = toGroups(text.slice(0, doubleColon));
    const right = toGroups(text.slice(doubleColon + 2));
    if (!left || !right) return null;
    head = left;
    rest = right;
  } else {
    const all = toGroups(text);
    if (!all) return null;
    head = all;
    rest = [];
  }

  // The dotted-quad placeholder group we substituted above is dropped again.
  if (tail.length) {
    if (rest.length) rest = rest.slice(0, rest.length - 1);
    else head = head.slice(0, head.length - 1);
  }

  const known = head.length + rest.length + tail.length;
  if (known > 8) return null;
  if (doubleColon < 0 && known !== 8) return null;

  const fill: number[] = [];
  for (let i = 0; i < 8 - known; i++) fill.push(0);
  return head.concat(fill, rest, tail);
}

/**
 * True when an IPv6 address is one the engine must never reach.
 *
 * Blocked: `::1/128` (loopback), `::/128` (unspecified), `fc00::/7` (unique
 * local), `fe80::/10` (link-local). IPv4-mapped (`::ffff:a.b.c.d`) and the
 * deprecated IPv4-compatible (`::a.b.c.d`) forms are re-checked as IPv4, so
 * `http://[::ffff:10.100.0.10]/` is refused exactly like `http://10.100.0.10/`.
 */
export function isPrivateIpv6(value: string): boolean {
  const g = parseIpv6(value);
  if (!g) return false;

  const embeddedV4 = (): string =>
    `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;

  // ::ffff:a.b.c.d — IPv4-mapped
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isPrivateIpv4(embeddedV4());
  }
  // ::a.b.c.d — IPv4-compatible (deprecated). ::0 and ::1 are handled below.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const v4 = (g[6] << 16) + g[7];
    if (v4 === 0) return true;  // ::   (unspecified)
    if (v4 === 1) return true;  // ::1  (loopback)
    return isPrivateIpv4(embeddedV4());
  }

  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7  unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/**
 * True when a bare IP literal (v4 or v6) is in a range the engine must not reach.
 * Anything that is not a recognisable IP literal returns false — callers resolve
 * hostnames through {@link assertPublicUrl} instead of passing them here.
 */
export function isPrivateAddress(value: string): boolean {
  if (!value) return false;
  const stripped = value.trim().replace(/^\[|\]$/g, '');
  const family = isIP(stripped);
  if (family === 4) return isPrivateIpv4(stripped);
  if (family === 6) return isPrivateIpv6(stripped);
  // Not an IP literal per Node — still classify shapes Node rejects but a
  // resolver might hand back (defensive; costs nothing).
  return isPrivateIpv4(stripped) || isPrivateIpv6(stripped);
}

// ===========================================================================
// DNS resolution (swappable for tests)
// ===========================================================================

/** Resolver signature: hostname -> every address it resolves to. */
export type SsrfLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const realLookup: SsrfLookup = async (hostname) => {
  const result = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return result.map((r) => ({ address: r.address, family: r.family }));
};

let activeLookup: SsrfLookup = realLookup;

/**
 * Test seam. Pass a fake resolver to make the guard deterministic and offline;
 * pass `null` to restore the real `dns.lookup`. Never called by production code.
 */
export function __setSsrfLookupForTests(fn: SsrfLookup | null): void {
  activeLookup = fn || realLookup;
}

// ===========================================================================
// The guard
// ===========================================================================

/**
 * Throw {@link SsrfBlockedError} unless `rawUrl` is an http(s) URL whose host
 * resolves exclusively to public addresses.
 *
 * @param rawUrl absolute URL to check
 * @returns the addresses the host resolved to (the literal itself for an IP URL)
 */
export async function assertPublicUrl(rawUrl: string): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('BLOCKED_INVALID_URL', `Not a valid URL: ${rawUrl}`, rawUrl);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(
      'BLOCKED_SCHEME',
      `Refusing to request '${parsed.protocol}' — only http and https are allowed`,
      rawUrl,
    );
  }

  // `URL.hostname` keeps IPv6 literals bracketed; strip for classification.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) {
    throw new SsrfBlockedError('BLOCKED_INVALID_URL', `URL has no host: ${rawUrl}`, rawUrl);
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new SsrfBlockedError(
        'BLOCKED_PRIVATE_ADDRESS',
        `Refusing to request a private/loopback address (${host}). ` +
          'Tools that fetch URLs may only reach public internet hosts.',
        rawUrl,
        host,
        host,
      );
    }
    return [host];
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await activeLookup(host);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SsrfBlockedError(
      'BLOCKED_UNRESOLVABLE',
      `Could not resolve host '${host}': ${detail}`,
      rawUrl,
      host,
    );
  }

  if (!addresses || addresses.length === 0) {
    throw new SsrfBlockedError(
      'BLOCKED_UNRESOLVABLE',
      `Host '${host}' resolved to no addresses`,
      rawUrl,
      host,
    );
  }

  // Fail closed on ANY private answer: a name that resolves to one public and
  // one private address must not be reachable, because which one `fetch` picks
  // is not ours to decide.
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new SsrfBlockedError(
        'BLOCKED_PRIVATE_ADDRESS',
        `Refusing to request '${host}' — it resolves to a private/loopback address ` +
          `(${entry.address}). Tools that fetch URLs may only reach public internet hosts.`,
        rawUrl,
        host,
        entry.address,
      );
    }
  }

  return addresses.map((a) => a.address);
}

/** True for the HTTP status codes that carry a `Location` redirect. */
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Resolve a `Location` header against the URL it came from and re-run the
 * guard on the result. Throws {@link SsrfBlockedError} when the hop is refused.
 */
export async function assertPublicRedirect(currentUrl: string, location: string): Promise<string> {
  let next: string;
  try {
    next = new URL(location, currentUrl).toString();
  } catch {
    throw new SsrfBlockedError(
      'BLOCKED_INVALID_URL',
      `Redirect target is not a valid URL: ${location}`,
      location,
    );
  }
  await assertPublicUrl(next);
  return next;
}

/**
 * Normalise a `HeadersInit` into a plain record so hops can strip fields.
 * Only the shapes this engine actually passes are handled (plain object,
 * `Headers`, entry array).
 */
function toHeaderRecord(init: HeadersInit | undefined): Record<string, string> {
  if (!init) return {};
  if (Array.isArray(init)) {
    const out: Record<string, string> = {};
    for (const pair of init) out[pair[0]] = pair[1];
    return out;
  }
  if (typeof Headers !== 'undefined' && init instanceof Headers) {
    const out: Record<string, string> = {};
    init.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return { ...(init as Record<string, string>) };
}

/** Drop credential-bearing headers — used when a redirect changes origin. */
function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.indexOf(key.toLowerCase()) >= 0) continue;
    out[key] = headers[key];
  }
  return out;
}

export interface SafeFetchOptions {
  /** Follow redirects manually, re-checking each hop. Default true. */
  followRedirects?: boolean;
  /** Hop budget. Default {@link MAX_REDIRECT_HOPS}. */
  maxRedirects?: number;
}

/**
 * `fetch`, with the guard applied to the initial URL and to every redirect hop.
 *
 * Redirects are followed by hand (`redirect: 'manual'`) precisely so each hop
 * passes {@link assertPublicUrl} before a connection is opened, and so
 * credential headers are dropped when the origin changes. When
 * `followRedirects` is false the 3xx response is returned to the caller as-is.
 *
 * `globalThis.fetch` is read at call time so a test that replaces it is honoured.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const follow = options.followRedirects !== false;
  const maxHops = typeof options.maxRedirects === 'number' ? options.maxRedirects : MAX_REDIRECT_HOPS;

  let currentUrl = url;
  let method = (init.method || 'GET').toUpperCase();
  let body = init.body;
  let headers = toHeaderRecord(init.headers as HeadersInit | undefined);

  await assertPublicUrl(currentUrl);

  for (let hop = 0; ; hop++) {
    const response = await globalThis.fetch(currentUrl, {
      ...init,
      method,
      body,
      headers,
      redirect: 'manual',
    });

    if (!follow || !isRedirectStatus(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    if (hop >= maxHops) {
      throw new SsrfBlockedError(
        'BLOCKED_TOO_MANY_REDIRECTS',
        `Too many redirects (limit ${maxHops}) starting from ${url}`,
        currentUrl,
      );
    }

    const nextUrl = await assertPublicRedirect(currentUrl, location);

    if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
      headers = stripSensitiveHeaders(headers);
    }
    // 303 always becomes GET; 301/302 on a non-GET body request follow the
    // universal browser convention and become GET too. 307/308 preserve both.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
    }
    currentUrl = nextUrl;
  }
}
