/**
 * Fork Graph — Native Platform Tool
 *
 * Creates a personal copy of a graph via the webapp API
 * (`POST /api/v1/graphs/:graphId/fork`). Works for system, public, and shared
 * graphs — anything the caller can read can be forked.
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.1
 *   - inputs: graphId (required), newGraphId? (custom ID)
 *   - output: { graphId: newId, forkedFrom: originalId }
 *
 * Forking is the canonical way to mutate a system graph: you can't
 * delete/edit `isSystem: true` graphs directly, you fork them and mutate the
 * fork. The forked copy inherits the source's nodes + edges + tier and is
 * owned by the caller.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ForkGraphArgs {
  graphId: string;
  newGraphId?: string;
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

const forkGraphTool: NativeToolDefinition = {
  description:
    'Fork a graph — create a personal mutable copy. Works for system, public, and shared graphs. Use before update_graph or delete_graph on system assets.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'The graphId of the graph to fork.',
      },
      newGraphId: {
        type: 'string',
        description:
          'Optional custom graphId for the fork. When omitted, the server generates one.',
      },
      name: {
        type: 'string',
        description: 'Optional custom name for the fork. Defaults to "<original> (Fork)".',
      },
    },
    required: ['graphId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ForkGraphArgs>;
    const graphId = typeof args.graphId === 'string' ? args.graphId.trim() : '';
    const newGraphId = typeof args.newGraphId === 'string' ? args.newGraphId.trim() : undefined;
    const name = typeof args.name === 'string' ? args.name.trim() : undefined;

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
    const url = `${baseUrl}/api/v1/graphs/${encodeURIComponent(graphId)}/fork`;

    const body: AnyObject = {};
    if (newGraphId) body.newGraphId = newGraphId;
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
                  `Graphs API ${response.status} ${response.statusText}` +
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
                graphId,
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
              forkedFrom: data?.parentGraphId ?? graphId,
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
          { type: 'text', text: JSON.stringify({ error: message, graphId }) },
        ],
        isError: true,
      };
    }
  },
};

export default forkGraphTool;
module.exports = forkGraphTool;
