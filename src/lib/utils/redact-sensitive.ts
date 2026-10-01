const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password', 'passwd',
  'secret', 'secrets', 'secretvalue', 'token', 'authtoken', 'accesstoken',
  'refreshtoken', 'servicetoken', 'apikey', 'privatekey', 'sshkey', 'resolvedsshkey',
  'clientsecret', 'internalkey', 'credentials',
]);

export function sensitiveKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_KEYS.has(norm)) return true;
  if (
    norm.endsWith('token') ||
    norm.endsWith('tokens') ||
    norm.endsWith('secret') ||
    norm.endsWith('secrets') ||
    norm.endsWith('password') ||
    norm.endsWith('passwd') ||
    norm.endsWith('credential') ||
    norm.endsWith('credentials') ||
    norm.endsWith('apikey') ||
    norm.endsWith('privatekey') ||
    norm.endsWith('sshkey') ||
    norm.endsWith('secretkey') ||
    norm.endsWith('authkey') ||
    norm.endsWith('accesskey') ||
    norm.includes('bearer')
  ) {
    return true;
  }
  return false;
}

// A URI scheme is short by definition (RFC 3986). The original
// `[a-z0-9+.-]*` was unbounded, so on a long string containing no `://` the
// engine consumed to the end and backtracked at EVERY start offset —
// quadratic. Measured on a fleet node (node 22): 64 KB -> 3.2 s, 128 KB ->
// 12.9 s, 156 KB -> 19.1 s. `sanitizeStreamEvent` runs this on every published
// stream event inside the hub process, and `tool_result` payloads averaged
// 155 KB with a 1.5 MB peak, so one event could block the hub for minutes.
// Bounding the scheme and the private-key body keeps every pattern linear.
const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
/** A key block whose END marker was truncated away still has to be masked. */
const PRIVATE_KEY_HEADER_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*/g;
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const URL_CREDENTIAL_RE = /([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{1,256}:)[^\s@/]{1,256}@/gi;
const RPAT_RE = /\brpat_[A-Za-z0-9_-]+/g;
/** Workspace registration token, `rreg_<payload>.<signature>` (workspaces/workspace-token.ts). */
const RREG_RE = /\brreg_[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g;
const SK_RE = /\bsk-[A-Za-z0-9_-]+/g;
const GHP_RE = /\bghp_[A-Za-z0-9]+/g;
/** GitHub App installation / OAuth / refresh tokens and fine-grained PATs. */
const GH_TOKEN_RE = /\b(?:ghs|gho|ghu|ghr)_[A-Za-z0-9]+/g;
const GITHUB_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]+/g;
const AKIA_RE = /\bAKIA[0-9A-Z]{12,}/g;
/** redauth refresh token (`rfsh_…`, the CLI's long-lived cloud login). */
const RFSH_RE = /\brfsh_[A-Za-z0-9_-]+/g;
/**
 * `key: value` / `key=value` / `"key": "value"` inside free text (command
 * stdout, a cat'ed JSON or .env file). The structured walk only sees object
 * keys, so a credential file printed by `run_command` reached the model with
 * any value no token pattern recognised (2026-10-01: a `rfsh_` refresh token
 * from ~/.config/redbtn/credentials.d). Bounded key/value lengths keep it linear.
 */
const KEY_VALUE_RE = /(["']?)([A-Za-z][A-Za-z0-9_.-]{0,63})\1(\s{0,4}[:=]\s{0,4})(["']?)([^\s"',;}\]]{1,4096})\4/g;

/**
 * Only values shaped like a credential: long enough, carrying a digit, and not
 * a plain number. References (`process.env.TOKEN`, `config.apiKey`) and type
 * annotations carry no digit, so they pass through. Source code the agent greps (`token: string`) stays readable.
 */
function looksLikeSecretValue(val: string): boolean {
  if (val.length < 12) return false;
  if (!/\d/.test(val)) return false;
  if (/^-?\d+(?:\.\d+)?$/.test(val)) return false;
  return true;
}

function redactKeyValues(text: string): string {
  return text.replace(KEY_VALUE_RE, (match, q1, key, sep, q2, val) => {
    if (!sensitiveKey(key)) return match;
    if (val === REDACTED || !looksLikeSecretValue(val)) return match;
    return `${q1}${key}${q1}${sep}${q2}${REDACTED}${q2}`;
  });
}

function redactString(value: string): string {
  let out = value;
  // Cheap substring guards: the two multi-part patterns are the expensive ones
  // and almost never apply, so skip them outright when their anchor is absent.
  if (out.includes('-----BEGIN')) {
    out = out.replace(PRIVATE_KEY_RE, REDACTED).replace(PRIVATE_KEY_HEADER_RE, REDACTED);
  }
  if (out.includes('://')) out = out.replace(URL_CREDENTIAL_RE, `$1${REDACTED}@`);
  if (out.includes(':') || out.includes('=')) out = redactKeyValues(out);
  return out
    .replace(AUTH_SCHEME_RE, `$1 ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(RPAT_RE, REDACTED)
    .replace(RREG_RE, REDACTED)
    .replace(SK_RE, REDACTED)
    .replace(GHP_RE, REDACTED)
    .replace(GH_TOKEN_RE, REDACTED)
    .replace(GITHUB_PAT_RE, REDACTED)
    .replace(AKIA_RE, REDACTED)
    .replace(RFSH_RE, REDACTED);
}

/** Return a JSON-compatible, non-mutating copy with credential values masked. */
export function redactSensitive<T>(value: T, rootKey = ''): T {
  const seen = new WeakSet<object>();

  const visit = (input: unknown, key = ''): unknown => {
    if (key && sensitiveKey(key)) return REDACTED;
    if (typeof input === 'string') return redactString(input);
    if (input === null || typeof input !== 'object') return input;
    if (input instanceof Date) return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map((entry) => visit(entry));
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([childKey, child]) => [childKey, visit(child, childKey)]),
    );
  };

  return visit(value, rootKey) as T;
}

export { REDACTED };
