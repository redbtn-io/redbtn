/**
 * Get Graph — Native Graph Tool
 *
 * Returns the full definition of a single graph the caller can access via the
 * webapp API (`GET /api/v1/graphs/:graphId`).
 *
 * Spec: TOOL-HANDOFF.md §4.9
 *   - inputs: graphId
 *   - output: full graph definition (nodes, edges, layout, schema, metadata)
 *
 * Access is enforced server-side by `verifyGraphAccess` — owner, participant,
 * public, or system. Forbidden / not-found surface as `isError: true`.
 *
 * Use this to inspect a graph's input schema (`inputSchema`) before invoking
 * it via `invoke_graph`, or to introspect the node/edge structure.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetGraphArgs {
  graphId?: string;
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

const getGraphTool: NativeToolDefinition = {
  description:
    'Fetch the full definition of a single graph (nodes, edges, layout, input schema, metadata). Use to inspect a graph\'s shape and required inputs before invoking it via invoke_graph.',
  server: 'graph',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'The graphId of the graph to fetch.',
      },
    },
    required: ['graphId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetGraphArgs>;
    const graphId = typeof args.graphId === 'string' ? args.graphId.trim() : '';

    if (!graphId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'graphId is required', code: 'VALIDATION' }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/graphs/${encodeURIComponent(graphId)}`;

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
                  `Graph API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
                graphId,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      // Route returns { graph: {...} } — surface the inner object directly so
      // agents don't need to peel off the wrapper.
      const graph = (data?.graph ?? data) as AnyObject;

      return {
        content: [
          { type: 'text', text: JSON.stringify({ graph }) },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message, graphId }) },
        ],
        isError: true,
      };
    }
  },
};

export default getGraphTool;
module.exports = getGraphTool;
