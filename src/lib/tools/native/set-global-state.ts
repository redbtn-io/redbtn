/**
 * Set Global State — Native Tool
 *
 * Writes a single value into a global-state namespace via the webapp API
 * (`POST /api/v1/state/namespaces/:namespace/values`).
 *
 * Spec: TOOL-HANDOFF.md §4.2
 *   - inputs: namespace (required), key (required), value (required, arbitrary JSON),
 *             description? (string, UI metadata),
 *             ttlSeconds? (number, server-enforced TTL)
 *   - output: { ok: true } on success, or structured error on 422 schema validation failure
 *
 * Auth: same Bearer / X-Internal-Key fallback pattern as other state tools.
 *
 * Notes:
 *   - The underlying API will lazily create the namespace on first write
 *     with the caller as owner (see `ensureNamespaceForWrite`).
 *   - If the namespace exists but the caller lacks member+ access, the
 *     API returns 403 — that surfaces here as `isError: true`.
 *   - On 422 schema validation failure, returns structured error with
 *     `expectedSchema` and `validationErrors` fields for repair/retry.
 *   - Per the handoff spec, we do NOT use GlobalStateClient's in-memory
 *     cache. Each tool call is independent.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface SetGlobalStateArgs {
  namespace: string;
  key: string;
  value: unknown;
  description?: string;
  ttlSeconds?: number;
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

function extractErrorMessage(data: AnyObject): string | null {
  if (typeof data.error === 'string') return data.error;
  if (data.error && typeof data.error === 'object') {
    const e = data.error as AnyObject;
    if (typeof e.message === 'string') return e.message;
  }
  if (typeof data.message === 'string') return data.message;
  return null;
}

const setGlobalStateTool: NativeToolDefinition = {
  description:
    'Write a value into a global-state namespace. Use to persist data that survives across runs (e.g. a counter, a learned preference, a cached lookup). ' +
    'If the namespace has a schema, validation errors (422) include expectedSchema and validationErrors fields for structured error handling.',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace name (created on first write if absent).',
      },
      key: {
        type: 'string',
        description: 'The key within the namespace.',
      },
      value: {
        description:
          'The value to store. Accepts any JSON-serialisable value (string, number, boolean, object, array, null).',
      },
      description: {
        type: 'string',
        description:
          'Optional UI-facing description for this entry. Stored as metadata; does not affect retrieval.',
      },
      ttlSeconds: {
        type: 'integer',
        description:
          'Optional time-to-live in seconds. The value is automatically evicted after this many seconds.',
        minimum: 1,
      },
    },
    required: ['namespace', 'key', 'value'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<SetGlobalStateArgs>;
    const namespace = typeof args.namespace === 'string' ? args.namespace.trim() : '';
    const key = typeof args.key === 'string' ? args.key.trim() : '';
    const value = args.value;
    const description = typeof args.description === 'string' ? args.description : undefined;
    const ttlSeconds =
      args.ttlSeconds !== undefined && Number.isFinite(Number(args.ttlSeconds))
        ? Math.max(1, Math.floor(Number(args.ttlSeconds)))
        : undefined;

    if (!namespace) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'namespace is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    if (!key) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'key is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    if (value === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'value is required (use null for an explicit null value)',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url =
      `${baseUrl}/api/v1/state/namespaces/${encodeURIComponent(namespace)}/values`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
        body: JSON.stringify({ key, value, description, ttlSeconds }),
      });

<<<<<<< HEAD
      const text = await response.text();
      let data: unknown = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }
=======
      const data = await response.json().catch(() => ({}));
>>>>>>> beta

      if (!response.ok) {
        // Surface the webapp's error envelope verbatim. For 422 schema validation errors,
        // the webapp returns { error: { message, code }, expectedSchema, validationErrors }.
        // Pass through structured to the caller so graphs can handle validation feedback.
        return {
          content: [
            {
              type: 'text',
<<<<<<< HEAD
              text: JSON.stringify({
                error:
                  (typeof data === 'object' && data !== null
                    ? extractErrorMessage(data as AnyObject)
                    : null) ||
                  `Global state API ${response.status} ${response.statusText}`,
=======
              text: JSON.stringify(data || {
                error: `Global state API ${response.status} ${response.statusText}`,
>>>>>>> beta
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
            text: JSON.stringify({ ok: true }),
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

export default setGlobalStateTool;
module.exports = setGlobalStateTool;
