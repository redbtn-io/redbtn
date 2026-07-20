const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password', 'passwd',
  'secret', 'secrets', 'secretvalue', 'token', 'authtoken', 'accesstoken',
  'refreshtoken', 'servicetoken', 'apikey', 'privatekey', 'sshkey', 'resolvedsshkey',
  'clientsecret', 'internalkey', 'credentials',
]);

function sensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function redactString(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`);
}

/** Return a JSON-compatible, non-mutating copy with credential values masked. */
export function redactSensitive<T>(value: T): T {
  const seen = new WeakSet<object>();

  const visit = (input: unknown, key = ''): unknown => {
    if (sensitiveKey(key)) return REDACTED;
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

  return visit(value) as T;
}

export { REDACTED };
