/**
 * Get Global State — Native Tool
 *
 * Reads a single value from a global-state namespace via the webapp API
 * (`GET /api/v1/state/namespaces/:namespace/values/:key`).
 *
 * Spec: TOOL-HANDOFF.md §4.2
 *   - inputs: namespace (required), key (required)
 *   - output: { value: any, exists: boolean }
 *
 * Auth pattern (mirrors GlobalStateClient.getValue):
 *   - Authorization: Bearer ${authToken} when context.state.authToken present
 *   - Fallback: X-Internal-Key + X-User-Id headers
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetGlobalStateArgs {
  namespace: string;
  key: string;
}

/**
 * Resolve the webapp base URL the same way GlobalStateClient does.
 * Tests stub this via `WEBAPP_URL`.
 */
function getBaseUrl(): string {
  return process.env.WEBAPP_URL || 'http://localhost:3000';
}

/**
 * Build the auth-and-content headers used for state-API calls.
 *
 * Mirrors GlobalStateClient.getHeaders() — auth precedence is
 * Bearer first, then internal-key + user-id, then anonymous.
 */
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

const getGlobalStateTool: NativeToolDefinition = {
  description:
    'Read a single value from a global-state namespace. Use to fetch persistent data shared across workflow runs (e.g. counters, config, last-seen markers).',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace name (e.g. "user-prefs").',
      },
      key: {
        type: 'string',
        description: 'The key within the namespace (e.g. "favourite_color").',
      },
    },
    required: ['namespace', 'key'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetGlobalStateArgs>;
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
      const response = await fetch(url, { headers: buildHeaders(context) });

      // 404 → key not found is a normal "exists: false" result, not an error.
      if (response.status === 404) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ value: null, exists: false }),
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
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              value: data?.value ?? null,
              exists: true,
            }),
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

export default getGlobalStateTool;
module.exports = getGlobalStateTool;
