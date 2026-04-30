/**
 * Create Graph — Native Platform Tool
 *
 * Creates a new graph (DAG of nodes + edges) via the webapp API
 * (`POST /api/v1/graphs`).
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.1
 *   - inputs: graphId? (string), config: GraphConfig
 *   - output: { graphId, createdAt }
 *
 * The webapp route accepts a top-level body: `{ name, description?, nodes,
 * edges, tier?, ...}`. We forward `config` as-is at the top level so callers
 * can either pass a single `config` object or build their own — whichever is
 * more convenient. `graphId` is forwarded verbatim if provided; the route
 * generates one when omitted.
 *
 * Auth follows the standard Bearer / X-Internal-Key fallback pattern used by
 * every other native tool.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface CreateGraphArgs {
  graphId?: string;
  config: AnyObject;
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

const createGraphTool: NativeToolDefinition = {
  description:
    'Create a new graph (DAG of nodes + edges). The platform is config-driven — graphs are JSON documents stored in MongoDB. Use this to build a workflow from scratch.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description:
          'Optional custom graphId. When omitted, the server generates one. Use lowercase letters, numbers, and hyphens.',
      },
      config: {
        type: 'object',
        description:
          'GraphConfig object: { name, description?, nodes: GraphNode[], edges: GraphEdge[], graphType?, tier?, isPublic?, tags?, inputSchema?, defaultInput?, layout? }. nodes and edges are required. See PLATFORM-PACK-HANDOFF.md for the full schema.',
      },
    },
    required: ['config'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<CreateGraphArgs>;
    const config = args.config && typeof args.config === 'object' ? args.config : null;
    const graphId = typeof args.graphId === 'string' ? args.graphId.trim() : undefined;

    if (!config) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'config is required and must be an object',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/graphs`;

    // Forward config fields at the top level; let graphId override anything in config.
    const body: AnyObject = { ...config };
    if (graphId) body.graphId = graphId;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
        body: JSON.stringify(body),
      });

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
                code:
                  response.status === 401
                    ? 'UNAUTHORIZED'
                    : response.status === 403
                    ? 'FORBIDDEN'
                    : response.status === 429
                    ? 'LIMIT_EXCEEDED'
                    : 'UPSTREAM_ERROR',
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
              graphId: data?.graphId ?? null,
              createdAt: data?.createdAt ?? null,
              name: data?.name ?? null,
            }),
          },
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

export default createGraphTool;
