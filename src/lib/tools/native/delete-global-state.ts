/**
 * Delete Global State — Native Tool
 *
 * Deletes a single key from a global-state namespace via the webapp API
 * (`DELETE /api/v1/state/namespaces/:namespace/values/:key`).
 *
 * Spec: TOOL-HANDOFF.md §4.2
 *   - inputs: namespace (required), key (required)
 *   - output: { ok: true, existed: boolean }
 *
 * The API returns 404 when the key doesn't exist, which we surface as
 * `existed: false` (not an error) — that mirrors the spec's contract.
 *
 * GlobalStateClient.deleteValue() collapses 404 into success and loses the
 * "did it exist?" signal — that's why this tool calls fetch directly.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface DeleteGlobalStateArgs {
  namespace: string;
  key: string;
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

const deleteGlobalStateTool: NativeToolDefinition = {
  description:
    'Delete a single key from a global-state namespace. Returns whether the key existed before deletion.',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace name.',
      },
      key: {
        type: 'string',
        description: 'The key within the namespace to delete.',
      },
    },
    required: ['namespace', 'key'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<DeleteGlobalStateArgs>;
    const namespace = typeof args.namespace === 'string' ? args.namespace.trim() : '';
    const key = typeof args.key === 'string' ? args.key.trim() : '';

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

    const baseUrl = getBaseUrl();
    const url =
      `${baseUrl}/api/v1/state/namespaces/${encodeURIComponent(namespace)}` +
      `/values/${encodeURIComponent(key)}`;

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: buildHeaders(context),
      });

      // 404 → key did not exist, but the operation is conceptually successful
      // (idempotent delete). Return { ok: true, existed: false }.
      if (response.status === 404) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, existed: false }),
            },
          ],
        };
      }

      if (!response.ok) {
        let body = '';
        try {
          body = await response.text();
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  `Global state API ${response.status} ${response.statusText}` +
                  (body ? `: ${body.slice(0, 200)}` : ''),
                status: response.status,
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
            text: JSON.stringify({ ok: true, existed: true }),
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

export default deleteGlobalStateTool;
module.exports = deleteGlobalStateTool;
