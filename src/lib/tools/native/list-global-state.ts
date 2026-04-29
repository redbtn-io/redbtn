/**
 * List Global State — Native Tool
 *
 * Returns all key/value pairs in a global-state namespace via the webapp API
 * (`GET /api/v1/state/namespaces/:namespace/values`).
 *
 * Spec: TOOL-HANDOFF.md §4.2
 *   - inputs: namespace (required)
 *   - output: { values: { [key]: any } }
 *
 * The API returns `{ values: {...} }` — we forward it through unchanged
 * (and default to an empty object on 404 so an empty-but-existing namespace
 * is indistinguishable from a missing one, matching GlobalStateClient
 * `getNamespaceValues` behaviour).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ListGlobalStateArgs {
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

const listGlobalStateTool: NativeToolDefinition = {
  description:
    'List all key/value pairs in a global-state namespace. Use to enumerate everything stored under a namespace (e.g. all per-user prefs, all cached lookups).',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace name to enumerate.',
      },
    },
    required: ['namespace'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ListGlobalStateArgs>;
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
    const url =
      `${baseUrl}/api/v1/state/namespaces/${encodeURIComponent(namespace)}/values`;

    try {
      const response = await fetch(url, { headers: buildHeaders(context) });

      // Empty namespace or missing namespace → empty values map.
      if (response.status === 404) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ values: {} }),
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

      const data = (await response.json()) as AnyObject;
      const values =
        data?.values && typeof data.values === 'object' ? data.values : {};

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ values }),
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

export default listGlobalStateTool;
module.exports = listGlobalStateTool;
