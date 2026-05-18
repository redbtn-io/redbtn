/**
 * Internal-host allowlist for credential attachment.
 *
 * The `fetch_url` native tool attaches the calling run owner's credentials
 * (Bearer JWT / X-User-Id) ONLY when the target host is on this allowlist.
 * Every other host receives an unauthenticated request — the run owner's
 * session must never leak to a third-party host.
 *
 * Matching is an EXACT, case-insensitive hostname comparison. It is never a
 * substring, prefix, or suffix check: a naive `endsWith('redbtn.io')` would
 * authenticate look-alike hosts such as `app.redbtn.io.evil.com`.
 */

/** Hardcoded internal redbtn platform hosts. */
const STATIC_INTERNAL_HOSTS = ['app.redbtn.io', 'run.redbtn.io'];

/**
 * Extract the lowercased hostname from a configured base URL (e.g. WEBAPP_URL).
 * Accepts a full URL (`https://host:port/path`) or a bare host (`host:port`).
 * Returns null when the value is missing or unparseable.
 */
function hostFromBaseUrl(value: string | undefined): string | null {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  // A bare `host:port` value (no scheme) would be misparsed by `new URL` —
  // the host becomes the scheme. Prepend a scheme when one is absent.
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The full set of allowlisted internal hosts: the static platform hosts plus
 * the host of the configured WEBAPP_URL (so local, dev, and self-hosted
 * deployments authenticate too). Computed per call so env changes — including
 * those made by tests — are always reflected.
 */
export function getInternalHostAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const hosts = new Set(STATIC_INTERNAL_HOSTS);
  const webappHost = hostFromBaseUrl(env.WEBAPP_URL);
  if (webappHost) hosts.add(webappHost);
  return [...hosts];
}

/**
 * True when `url`'s host is an allowlisted internal redbtn host.
 *
 * Returns false for any unparseable URL and for any host not exactly present
 * in the allowlist (look-alike hosts included).
 */
export function isInternalHost(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;
  return getInternalHostAllowlist(env).includes(hostname);
}
