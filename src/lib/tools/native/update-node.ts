/**
 * Update Node — Native Platform Tool
 *
 * Patches an existing node config (PATCH /api/v1/nodes/:nodeId).
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.2
 *   - inputs: nodeId (required), patch
 *   - output: { ok: true }
 *
 * The webapp PATCH route auto-forks system/immutable/non-owned nodes when the
 * caller tries to change steps. The auto-fork response surfaces `forked: true`
 * + the new `nodeId`. Callers should switch to the returned nodeId for
 * subsequent edits to keep mutating their fork.
 *
 * If the caller is a member (not owner) and tries to change anything other
 * than name/description/tags/isPublic/isFavorite, the upstream returns 403 —
 * forking is the right next step.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface UpdateNodeArgs {
  nodeId: string;
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

const updateNodeTool: NativeToolDefinition = {
  description:
    'Update an existing node config (PATCH). Patch fields are optional. If the caller does not own the node (or it is system/immutable) and the patch includes step changes, the webapp auto-forks; the response includes forked: true + the new nodeId.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: {
        type: 'string',
        description: 'The nodeId of the node to update.',
      },
      patch: {
        type: 'object',
        description:
          'Partial NodeConfig: name?, description?, tags?, steps?, parameters?, metadata?, isPublic?, parserConfig?, newNodeId? (custom ID for auto-fork).',
      },
    },
    required: ['nodeId', 'patch'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<UpdateNodeArgs>;
    const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';
    const patch = args.patch && typeof args.patch === 'object' ? args.patch : null;

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
    const url = `${baseUrl}/api/v1/nodes/${encodeURIComponent(nodeId)}`;

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
              ok: true,
              nodeId: data?.nodeId ?? nodeId,
              forked: data?.forked === true,
              originalNodeId: data?.originalNodeId ?? null,
              name: data?.name ?? null,
              version: data?.version ?? null,
              updatedAt: data?.updatedAt ?? null,
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

export default updateNodeTool;
module.exports = updateNodeTool;
