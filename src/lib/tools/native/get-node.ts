/**
 * Get Node — Native Node Tool
 *
 * Returns the full definition of a single node (steps, parameters, metadata)
 * via the webapp API (`GET /api/nodes/:nodeId`).
 *
 * The response includes `fullConfig` (the raw step array) so an agent can
 * read every step type, prompt, tool name, and condition in the node. This
 * lets the GOD director understand exactly what a node does before deciding
 * whether to invoke a graph that contains it.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetNodeArgs {
  nodeId?: string;
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

const getNodeTool: NativeToolDefinition = {
  description:
    'Fetch the full definition of a single node (steps, parameters, metadata). ' +
    'The `fullConfig` field contains the raw step array — every neuron prompt, tool name, ' +
    'transform operation, and condition in the node. Use after get_graph to drill into ' +
    'the implementation of a specific node referenced by `nodeId` in a graph.',
  server: 'graph',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: {
        type: 'string',
        description: 'The nodeId of the node to fetch.',
      },
    },
    required: ['nodeId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetNodeArgs>;
    const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';

    if (!nodeId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'nodeId is required', code: 'VALIDATION' }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/nodes/${encodeURIComponent(nodeId)}`;

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
                  `Node API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
                nodeId,
              }),
            },
          ],
          isError: true,
        };
      }

      const node = (await response.json()) as AnyObject;

      return {
        content: [
          { type: 'text', text: JSON.stringify({ node }) },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message, nodeId }) },
        ],
        isError: true,
      };
    }
  },
};

export default getNodeTool;
module.exports = getNodeTool;
