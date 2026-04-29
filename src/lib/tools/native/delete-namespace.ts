/**
 * Delete Namespace — Native Tool
 *
 * Deletes an entire global-state namespace (and all its keys) via the webapp
 * API (`DELETE /api/v1/state/namespaces/:namespace`). Owner-only.
 *
 * Spec: TOOL-HANDOFF.md §4.2
 *   - inputs: namespace (required)
 *   - output: { ok: true, deletedKeys: number }
 *
 * Implementation note:
 *   The webapp DELETE endpoint returns `{ success, message }` without a
 *   deletedKeys count. To honour the spec, we issue a preflight GET to read
 *   the current keyCount, then DELETE. If the preflight fails (e.g. namespace
 *   does not exist), we surface that as a 404 / appropriate error.
 *   - 404 on preflight  → namespace does not exist → `{ ok: true, deletedKeys: 0 }`
 *     (idempotent delete, mirrors `delete_global_state` behaviour for missing keys).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface DeleteNamespaceArgs {
  namespace: string;
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

const deleteNamespaceTool: NativeToolDefinition = {
  description:
    'Delete an entire global-state namespace and all of its keys. Owner-only. Idempotent: deleting a missing namespace returns ok with deletedKeys: 0.',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace name to delete entirely.',
      },
    },
    required: ['namespace'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<DeleteNamespaceArgs>;
    const namespace = typeof args.namespace === 'string' ? args.namespace.trim() : '';

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

    const baseUrl = getBaseUrl();
    const headers = buildHeaders(context);
    const detailUrl =
      `${baseUrl}/api/v1/state/namespaces/${encodeURIComponent(namespace)}`;

    try {
      // 1. Preflight: count keys in the namespace.
      let deletedKeys = 0;
      const detail = await fetch(detailUrl, { headers });

      if (detail.status === 404) {
        // Idempotent: nothing to delete.
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, deletedKeys: 0 }),
            },
          ],
        };
      }

      if (!detail.ok) {
        let body = '';
        try {
          body = await detail.text();
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  `Global state API ${detail.status} ${detail.statusText}` +
                  (body ? `: ${body.slice(0, 200)}` : ''),
                status: detail.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const detailData = (await detail.json()) as AnyObject;
      deletedKeys = Number(detailData?.keyCount ?? 0);

      // 2. Delete the namespace.
      const del = await fetch(detailUrl, { method: 'DELETE', headers });

      // Race: namespace deleted between preflight and DELETE.
      if (del.status === 404) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, deletedKeys: 0 }),
            },
          ],
        };
      }

      if (!del.ok) {
        let body = '';
        try {
          body = await del.text();
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  `Global state API ${del.status} ${del.statusText}` +
                  (body ? `: ${body.slice(0, 200)}` : ''),
                status: del.status,
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
            text: JSON.stringify({ ok: true, deletedKeys }),
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

export default deleteNamespaceTool;
module.exports = deleteNamespaceTool;
