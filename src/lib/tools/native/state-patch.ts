/**
 * State Patch — Native Tool
 *
 * Apply a JSON-patch-style ops list to an existing global-state value via
 * the webapp API (`PATCH /api/v1/state/namespaces/:namespace/values/:key`)
 * WITHOUT re-transmitting the full value. Use instead of `set_global_state`
 * when you only need to change a small portion of a large value — e.g.
 * flipping one todo's `done` flag inside a 75KB project record.
 *
 * Inputs:
 *   - namespace (required, string)
 *   - key       (required, string) — the key must already exist; use
 *                                    `set_global_state` first to create.
 *   - ops       (required, array of patch operations, max 100)
 *       { op: 'set' | 'append' | 'prepend' | 'merge' | 'remove' | 'inc',
 *         path: string,  // RFC 6901 JSON Pointer e.g. '/todo/12/done'
 *         value?: any }  // omitted for `remove`
 *
 * Output: the new full value after the patch is applied, so the caller
 *         can verify the result (matches the webapp endpoint's contract).
 *         On 422 schema validation failure, returns structured error with
 *         `expectedSchema` and `validationErrors` fields for repair/retry.
 *
 * Auth: same Bearer / X-Internal-Key fallback pattern as other state tools.
 *
 * Notes:
 *   - Atomicity: the webapp reads the existing value, applies ops in
 *     memory, then writes back in a single `$set` — atomic at doc level.
 *   - Path syntax: RFC 6901 JSON Pointer; `/` separates segments and the
 *     escapes `~0` (`~`) and `~1` (`/`) apply.
 *   - Returns 404 if the key doesn't exist (use `set_global_state` first).
 *   - Returns 422 if the path references a structure of the wrong type,
 *     or if the namespace has schema validation enabled and the result
 *     fails validation.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface PatchOp {
  op: 'set' | 'append' | 'prepend' | 'merge' | 'remove' | 'inc';
  path: string;
  value?: unknown;
}

interface StatePatchArgs {
  namespace: string;
  key: string;
  ops: PatchOp[];
}

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
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message, code: 'VALIDATION' }),
      },
    ],
    isError: true,
  };
}

const statePatchTool: NativeToolDefinition = {
  description:
    'Apply a JSON-patch-style ops list to an existing state value WITHOUT re-transmitting the full value. ' +
    'Use instead of set_global_state when only changing a small portion of a large value — e.g. flipping ' +
    "one todo's `done` flag inside a 75KB project record. The op list is typically ~200 bytes, vs the " +
    'full inline value being many KB. Paths use RFC 6901 JSON Pointer syntax ("/foo/0/bar" addresses ' +
    'element 0 of `foo`, then its `bar` field). Supported ops: ' +
    '`set` (replace at path), `append` (push to array at path), `prepend` (unshift to array at path), ' +
    '`merge` (shallow-merge object into existing object at path), `remove` (delete element/key at path), ' +
    '`inc` (numeric increment). Returns the full updated value on success so the caller can verify. ' +
    'If the namespace has a schema, validation errors (422) include expectedSchema and validationErrors fields.',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'Namespace name.',
      },
      key: {
        type: 'string',
        description: 'Key name. The key must already exist — use set_global_state first to create.',
      },
      ops: {
        type: 'array',
        description:
          'Ordered list of patch operations. Applied left-to-right; each op sees the cumulative ' +
          'result of earlier ops. Max 100 ops per call.',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['set', 'append', 'prepend', 'merge', 'remove', 'inc'],
              description: 'Operation kind.',
            },
            path: {
              type: 'string',
              description:
                'JSON Pointer (RFC 6901) — slash-delimited, with array indices as numbers. ' +
                'e.g. "/todo/12/done" addresses the `done` field of element 12 in the `todo` array.',
            },
            value: {
              description:
                'Operand value. Required for set/append/prepend/merge/inc; omitted for remove. ' +
                'For `inc`, must be a number. For `merge`, must be an object.',
            },
          },
          required: ['op', 'path'],
        },
        minItems: 1,
        maxItems: 100,
      },
    },
    required: ['namespace', 'key', 'ops'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<StatePatchArgs>;
    const namespace = typeof args.namespace === 'string' ? args.namespace.trim() : '';
    const key = typeof args.key === 'string' ? args.key.trim() : '';

    if (!namespace) return validationError('namespace is required and must be a non-empty string');
    if (!key) return validationError('key is required and must be a non-empty string');

    if (!Array.isArray(args.ops)) {
      return validationError('ops is required and must be an array of patch operations');
    }
    if (args.ops.length === 0) {
      return validationError('ops must contain at least one operation');
    }
    if (args.ops.length > 100) {
      return validationError('ops cannot contain more than 100 operations');
    }

    const baseUrl = getBaseUrl();
    const url =
      `${baseUrl}/api/v1/state/namespaces/${encodeURIComponent(namespace)}` +
      `/values/${encodeURIComponent(key)}`;

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: buildHeaders(context),
        body: JSON.stringify({ ops: args.ops }),
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
        // Surface the webapp's error envelope verbatim — webapp returns
        // `{ error: '...' }` (legacy) or `{ error: { message, type, code } }`
        // (newer). Either way we pass through to the caller.
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  (typeof data === 'object' && data !== null
                    ? extractErrorMessage(data as AnyObject)
                    : null) ||
                  `State patch API ${response.status} ${response.statusText}`,
                status: response.status,
                ...(typeof data === 'object' && data !== null ? { details: data } : {}),
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text:
              typeof data === 'string'
                ? data
                : JSON.stringify(data ?? { ok: true }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  },
};

function extractErrorMessage(data: AnyObject): string | null {
  if (typeof data.error === 'string') return data.error;
  if (data.error && typeof data.error === 'object') {
    const e = data.error as AnyObject;
    if (typeof e.message === 'string') return e.message;
  }
  if (typeof data.message === 'string') return data.message;
  return null;
}

export default statePatchTool;
module.exports = statePatchTool;
