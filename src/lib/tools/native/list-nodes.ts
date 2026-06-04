/**
 * List Nodes — Native Node Tool
 *
 * Lists nodes the caller can access (system + public + owned + shared) via
 * the webapp API (`GET /api/nodes`). Returns nodeId/name/description/tags
 * for each — lightweight summary suitable for browsing. Use get_node for
 * full step-level detail on a specific node.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ListNodesArgs {
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

const listNodesTool: NativeToolDefinition = {
  description:
    'List nodes the caller can access (owned, shared, public, and system). ' +
    'Returns nodeId/name/description/tags/isOwned/isSystem for each. ' +
    'Use to discover available nodes before calling get_node for full step details, ' +
    'or to understand what building blocks a graph can reference.',
  server: 'graph',
  inputSchema: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'Optional case-insensitive substring filter on name, description, and tags.',
      },
      mine: {
        type: 'boolean',
        description: 'When true, return only nodes the caller owns. Default false (includes system + public + shared).',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of nodes to return (default 50, max 200).',
      },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ListNodesArgs>;

    const baseUrl = getBaseUrl();
    const params = new URLSearchParams();

    if (args.search) params.set('q', String(args.search));
    if (args.limit) params.set('limit', String(Math.min(Number(args.limit), 200)));

    const url = `${baseUrl}/api/nodes?${params.toString()}`;

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
                  `Nodes API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const allNodes = (data?.nodes ?? []) as AnyObject[];

      // Optionally filter to owned nodes client-side (the API doesn't have a mine= param)
      const filtered = args.mine
        ? allNodes.filter((n) => n.isOwned === true)
        : allNodes;

      // Trim to a summary shape — agents don't need the full step configs here
      const nodes = filtered.map((n) => ({
        nodeId: n.nodeId,
        name: n.name,
        description: n.description,
        tags: n.tags || [],
        isSystem: n.isSystem ?? false,
        isOwned: n.isOwned ?? false,
        isPublic: n.isPublic ?? true,
      }));

      return {
        content: [
          { type: 'text', text: JSON.stringify({ nodes, total: nodes.length }) },
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

export default listNodesTool;
module.exports = listNodesTool;
