/**
 * State Atomic — Native Tool
 *
 * Race-free primitives on one global-state key, for locks / leases, claims,
 * quotas, exact counters and spend caps shared across parallel branches,
 * concurrent runs, fanned-out children and different graphs.
 *
 * Calls the webapp's
 * `POST /api/v1/state/namespaces/:namespace/values/:key/atomic`, where each
 * op is ONE conditional Mongo update (no read-modify-write window).
 *
 * Ops (field `op`):
 *   - read          -> { found, value, version, holder, expiresAt }
 *   - setIfAbsent   { value, ttlMs?, holder? } -> { won, holder, value, version, expiresAt }
 *                   Claim the key only if missing or expired. Exactly one of
 *                   any number of concurrent callers wins; the rest get
 *                   won:false plus the current holder. `holder` defaults to a
 *                   fresh token — keep it for heartbeat / release.
 *   - heartbeat     { holder, ttlMs } -> { ok, expiresAt | reason }
 *                   Extend a live lease; only its holder can.
 *   - release       { holder } -> { released | reason }
 *                   Delete the key only if `holder` still holds it.
 *   - compareAndSet { value, expected? | expectedVersion?, ttlMs? } -> { swapped, value, version | reason }
 *                   Replace only if unchanged (deep-equal `expected`, key order
 *                   ignored; or `expectedVersion` from `read`).
 *   - increment     { by?=1, initial?=0, onNonNumber?, ttlMs?, description? } -> { value, version, created }
 *                   Atomic add on a whole-key number; missing keys start at
 *                   `initial`. For a counter INSIDE an object value use
 *                   `state_patch` with an `inc` op (also atomic).
 *
 * A lost claim / failed compare is a normal result (isError false) with
 * `won: false` / `swapped: false` / `ok: false` and a `reason`.
 *
 * Auth: same Bearer / X-Internal-Key fallback pattern as the other state tools.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import { formatStateApiError } from '../state-error';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

const STATE_ATOMIC_OPS = ['read', 'setIfAbsent', 'heartbeat', 'release', 'compareAndSet', 'increment'] as const;
type StateAtomicOp = (typeof STATE_ATOMIC_OPS)[number];

/** Fields forwarded to the webapp per op (anything else is dropped). */
const FORWARDED_FIELDS: Record<StateAtomicOp, readonly string[]> = {
  read: [],
  setIfAbsent: ['value', 'ttlMs', 'holder', 'description'],
  heartbeat: ['holder', 'ttlMs'],
  release: ['holder'],
  compareAndSet: ['value', 'expected', 'expectedVersion', 'ttlMs'],
  increment: ['by', 'initial', 'onNonNumber', 'ttlMs', 'description'],
};

function getBaseUrl(): string {
  return process.env.WEBAPP_URL || 'http://localhost:3000';
}

function buildHeaders(context: NativeToolContext): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  const authToken =
    (context?.state?.authToken as string | undefined) ||
    (context?.state?.data?.authToken as string | undefined);
  const userId =
    (context?.state?.userId as string | undefined) ||
    (context?.state?.data?.userId as string | undefined);
  const internalKey = process.env.INTERNAL_SERVICE_KEY;

  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (userId) headers['X-User-Id'] = userId;
  if (internalKey) headers['X-Internal-Key'] = internalKey;

  return headers;
}

function validationError(message: string): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code: 'VALIDATION' }) }],
    isError: true,
  };
}

const stateAtomicTool: NativeToolDefinition = {
  description:
    'Race-free atomic operations on ONE global-state key — use for locks/leases, one-time claims, exact ' +
    'counters, quotas and spend caps that parallel branches, concurrent runs or different graphs share. ' +
    'Ops: `setIfAbsent` (claim the key only if missing or expired; exactly one concurrent caller wins; ' +
    'returns won + current holder; optional ttlMs auto-releases), `heartbeat` (holder extends its lease), ' +
    '`release` (holder deletes its lease), `compareAndSet` (replace only if the value still equals ' +
    '`expected` or its version equals `expectedVersion`), `increment` (atomic add on a numeric key; ' +
    'missing keys start at `initial`, default 0), `read` (value + version + holder + expiry). ' +
    'A lost claim or failed compare is a normal result (won:false / swapped:false / ok:false with a reason), ' +
    'not an error. For a field inside an object value, use state_patch (its ops are atomic too).',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace name.' },
      key: {
        type: 'string',
        description:
          'Key name. setIfAbsent / increment may create it (letters, digits, underscore; must not start with a digit).',
      },
      op: {
        type: 'string',
        enum: [...STATE_ATOMIC_OPS],
        description: 'Operation.',
      },
      value: {
        description: 'setIfAbsent: value to store when claiming. compareAndSet: the new value.',
      },
      ttlMs: {
        type: 'number',
        description:
          'Lease / value lifetime in milliseconds. setIfAbsent: auto-release after this long. heartbeat (required): ' +
          'new lifetime from now. compareAndSet / increment: refresh the expiry.',
      },
      holder: {
        type: 'string',
        description:
          'Lease owner token. setIfAbsent: optional (a random token is generated and returned). ' +
          'heartbeat / release: required — only the current holder succeeds.',
      },
      expected: {
        description: 'compareAndSet: swap only if the current value deep-equals this (object key order ignored).',
      },
      expectedVersion: {
        type: 'number',
        description: 'compareAndSet: swap only if the entry version equals this (get it from op "read").',
      },
      by: { type: 'number', description: 'increment: amount to add (negative to subtract). Default 1.' },
      initial: { type: 'number', description: 'increment: starting value for a missing key. Default 0.' },
      onNonNumber: {
        type: 'string',
        enum: ['error', 'reset'],
        description: 'increment: when the key holds a non-number, fail (default) or reset it to initial + by.',
      },
      description: { type: 'string', description: 'Optional description stored with a created key.' },
    },
    required: ['namespace', 'key', 'op'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const namespace = typeof rawArgs.namespace === 'string' ? rawArgs.namespace.trim() : '';
    const key = typeof rawArgs.key === 'string' ? rawArgs.key.trim() : '';
    const op = rawArgs.op as StateAtomicOp;

    if (!namespace) return validationError('namespace is required and must be a non-empty string');
    if (!key) return validationError('key is required and must be a non-empty string');
    if (typeof op !== 'string' || !(STATE_ATOMIC_OPS as readonly string[]).includes(op)) {
      return validationError(`op must be one of: ${STATE_ATOMIC_OPS.join(', ')}`);
    }
    if ((op === 'setIfAbsent' || op === 'compareAndSet') && rawArgs.value === undefined) {
      return validationError(`${op} requires value`);
    }
    if ((op === 'heartbeat' || op === 'release') && (typeof rawArgs.holder !== 'string' || !rawArgs.holder)) {
      return validationError(`${op} requires holder`);
    }
    if (op === 'heartbeat' && typeof rawArgs.ttlMs !== 'number') {
      return validationError('heartbeat requires ttlMs');
    }
    if (op === 'compareAndSet') {
      const hasExpected = Object.prototype.hasOwnProperty.call(rawArgs, 'expected');
      const hasVersion = rawArgs.expectedVersion !== undefined;
      if (hasExpected === hasVersion) {
        return validationError('compareAndSet requires exactly one of expected or expectedVersion');
      }
    }

    const body: AnyObject = { op };
    for (const field of FORWARDED_FIELDS[op]) {
      if (Object.prototype.hasOwnProperty.call(rawArgs, field) && rawArgs[field] !== undefined) {
        body[field] = rawArgs[field];
      }
    }
    // `expected: null` is a meaningful comparand — forward it explicitly.
    if (op === 'compareAndSet' && Object.prototype.hasOwnProperty.call(rawArgs, 'expected')) {
      body.expected = rawArgs.expected === undefined ? null : rawArgs.expected;
    }

    const url =
      `${getBaseUrl()}/api/v1/state/namespaces/${encodeURIComponent(namespace)}` +
      `/values/${encodeURIComponent(key)}/atomic`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let data: unknown = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }

      if (!response.ok) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(formatStateApiError(data, response.status, response.statusText, 'State atomic API')),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data ?? { ok: true }) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
    }
  },
};

export default stateAtomicTool;
module.exports = stateAtomicTool;
