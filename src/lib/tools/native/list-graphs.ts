/**
 * List Graphs — Native Graph Tool
 *
 * Lists graphs the caller can access (system + public + owned + shared) via
 * the webapp API (`GET /api/v1/graphs`).
 *
 * Spec: TOOL-HANDOFF.md §4.9
 *   - inputs: search?, mine? (default false), limit?
 *   - output: { graphs: [{ graphId, name, description, isOwned, isSystem }] }
 *
 * The webapp route already supports server-side `search` filtering against
 * name / description / tags via the `?search=` query param. When `mine: true`
 * we filter the result down to graphs the caller actually owns (drops system
 * + public + shared graphs).
 *
 * Auth resolution mirrors the rest of the native API tools — Bearer token /
 * X-User-Id / X-Internal-Key, in that priority order.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ListGraphsArgs {
  search?: string;
  mine?: boolean;
  limit?: number;
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

const listGraphsTool: NativeToolDefinition = {
  description:
    'List graphs the caller can access (owned, shared, public, and system). Returns graphId/name/description/isOwned/isSystem for each. Use to discover graphs before invoking one with invoke_graph.',
  server: 'graph',
  inputSchema: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description:
          'Optional case-insensitive substring filter. Matches against name, description, and tags via the server-side search.',
      },
      mine: {
        type: 'boolean',
        description:
          'When true, return only graphs the caller owns. When false (default), include accessible system + public + shared graphs as well.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of graphs to return (default 100, max 200).',
        minimum: 1,
        maximum: 200,
      },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ListGraphsArgs>;
    const search = typeof args.search === 'string' ? args.search.trim() : '';
    const mine = args.mine === true;
    const limit =
      args.limit !== undefined && Number.isFinite(Number(args.limit))
        ? Math.min(200, Math.max(1, Math.floor(Number(args.limit))))
        : 100;

    const baseUrl = getBaseUrl();
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (search) params.set('search', search);
    const url = `${baseUrl}/api/v1/graphs?${params.toString()}`;

    try {
      const response = await fetch(url, { headers: buildHeaders(context) });
      if (!response.ok) {
        let errBody = '';
        try {
          errBody = await response.text();
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  `Graphs API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const raw = Array.isArray(data?.graphs) ? (data.graphs as AnyObject[]) : [];

      let mapped = raw.map((g) => ({
        graphId: typeof g.graphId === 'string' ? g.graphId : String(g.graphId ?? ''),
        name: g.name ?? '',
        description: g.description ?? '',
        isOwned: g.isOwned === true,
        isSystem: g.isSystem === true,
      }));

      if (mine) {
        // Filter to graphs the caller actually owns. The route already returns
        // a mix of system + public + owned + shared; mine: true narrows to the
        // owned subset.
        mapped = mapped.filter((g) => g.isOwned);
      }

      mapped = mapped.slice(0, limit);

      return {
        content: [
          { type: 'text', text: JSON.stringify({ graphs: mapped }) },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message }) },
        ],
        isError: true,
      };
    }
  },
};

export default listGraphsTool;
module.exports = listGraphsTool;
