/**
 * Fork Node — Native Platform Tool
 *
 * Creates a personal copy of a node via the webapp API
 * (`POST /api/v1/nodes/:nodeId/fork`). Works for system, public, and shared
 * nodes — anything the caller can read can be forked.
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.2
 *   - inputs: nodeId (required), newNodeId? (custom ID)
 *   - output: { nodeId, forkedFrom }
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ForkNodeArgs {
  nodeId: string;
  newNodeId?: string;
  name?: string;
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

const forkNodeTool: NativeToolDefinition = {
  description:
    'Fork a node — create a personal mutable copy. Works for system, public, and shared nodes. Use before update_node or delete_node on system assets.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: {
        type: 'string',
        description: 'The nodeId of the node to fork.',
      },
      newNodeId: {
        type: 'string',
        description:
          'Optional custom nodeId for the fork. When omitted, the server generates one.',
      },
      name: {
        type: 'string',
        description: 'Optional custom name for the fork.',
      },
    },
    required: ['nodeId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ForkNodeArgs>;
    const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';
    const newNodeId = typeof args.newNodeId === 'string' ? args.newNodeId.trim() : undefined;
    const name = typeof args.name === 'string' ? args.name.trim() : undefined;

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
    const url = `${baseUrl}/api/v1/nodes/${encodeURIComponent(nodeId)}/fork`;

    const body: AnyObject = {};
    if (newNodeId) body.newNodeId = newNodeId;
    if (name) body.name = name;

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
                  `Nodes API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
                code:
                  response.status === 401
                    ? 'UNAUTHORIZED'
                    : response.status === 403
                    ? 'FORBIDDEN'
                    : response.status === 404
                    ? 'NOT_FOUND'
                    : response.status === 409
                    ? 'CONFLICT'
                    : 'UPSTREAM_ERROR',
                nodeId,
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
              nodeId: data?.nodeId ?? null,
              forkedFrom: data?.parentNodeId ?? data?.originalNodeId ?? nodeId,
              name: data?.name ?? null,
              createdAt: data?.createdAt ?? null,
            }),
          },
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

export default forkNodeTool;
