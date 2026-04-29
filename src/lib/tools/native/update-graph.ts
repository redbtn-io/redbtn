/**
 * Update Graph — Native Platform Tool
 *
 * Patches an existing graph (PATCH /api/v1/graphs/:graphId) with the given
 * partial config.
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.1
 *   - inputs: graphId (required), patch: Partial<GraphConfig>
 *   - output: { ok: true, updatedAt }
 *
 * The webapp PATCH route automatically forks system/immutable graphs into a
 * user copy if the caller is not the owner — that path is exposed in the
 * response via `cloned: true`. Agents that want to keep mutating their fork
 * should use the returned `graphId` for subsequent calls.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface UpdateGraphArgs {
  graphId: string;
  patch: AnyObject;
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

const updateGraphTool: NativeToolDefinition = {
  description:
    'Update an existing graph (PATCH). All fields in patch are optional. If the caller does not own the graph (or it is system/immutable), the webapp will auto-fork it and the response will include cloned: true and the new graphId — use that for subsequent edits.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'The graphId of the graph to update.',
      },
      patch: {
        type: 'object',
        description:
          'Partial GraphConfig to merge: name?, description?, nodes?, edges?, tier?, layout?, graphType?, isPublic?, tags?, inputSchema?, defaultInput?, newGraphId? (custom ID for auto-fork).',
      },
    },
    required: ['graphId', 'patch'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<UpdateGraphArgs>;
    const graphId = typeof args.graphId === 'string' ? args.graphId.trim() : '';
    const patch = args.patch && typeof args.patch === 'object' ? args.patch : null;

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

    if (!patch) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'patch is required and must be an object',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/graphs/${encodeURIComponent(graphId)}`;

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: buildHeaders(context),
        body: JSON.stringify(patch),
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
              ok: true,
              graphId: data?.graphId ?? graphId,
              cloned: data?.cloned === true,
              parentGraphId: data?.parentGraphId ?? null,
              updatedAt: data?.updatedAt ?? null,
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
          { type: 'text', text: JSON.stringify({ error: message, graphId }) },
        ],
        isError: true,
      };
    }
  },
};

export default updateGraphTool;
module.exports = updateGraphTool;
