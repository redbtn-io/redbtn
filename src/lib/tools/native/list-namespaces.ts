/**
 * List Namespaces — Native Tool
 *
 * Lists every global-state namespace the caller has access to (owner OR
 * participant) via the webapp API (`GET /api/v1/state/namespaces`).
 *
 * Spec: TOOL-HANDOFF.md §4.2
 *   - inputs: (none)
 *   - output: { namespaces: [{ name, keyCount, lastModified }] }
 *
 * The API returns rich namespace summary objects; we project them down to the
 * spec shape. Field mapping:
 *   API `namespace`    → `name`
 *   API `keyCount`     → `keyCount`
 *   API `lastUpdated`  → `lastModified`  (the API returns updatedAt as lastUpdated)
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

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

const listNamespacesTool: NativeToolDefinition = {
  description:
    'List every global-state namespace the caller can access (owned or shared). Use to discover available namespaces before reading or writing values.',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },

  async handler(_rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/state/namespaces`;

    try {
      const response = await fetch(url, { headers: buildHeaders(context) });

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
      const raw = Array.isArray(data?.namespaces) ? data.namespaces : [];

      const namespaces = raw.map((ns: AnyObject) => ({
        name: String(ns?.namespace ?? ''),
        keyCount: Number(ns?.keyCount ?? 0),
        // The API field is `lastUpdated`; spec wants `lastModified`.
        // Fall back to `updatedAt` if neither is present.
        lastModified: ns?.lastUpdated ?? ns?.updatedAt ?? null,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ namespaces }),
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

export default listNamespacesTool;
module.exports = listNamespacesTool;
