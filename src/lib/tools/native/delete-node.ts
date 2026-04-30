/**
 * Delete Node — Native Platform Tool
 *
 * Permanently deletes a user-owned node via the webapp API
 * (`DELETE /api/v1/nodes/:nodeId`).
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.2
 *   - inputs: nodeId (required)
 *   - output: { ok: true } — refuses if isSystem; warns if any graph references it
 *
 * SAFETY: Before calling DELETE, fetches the node via GET to check
 * `isSystem`. If `isSystem === true`, REFUSES with `code:
 * 'SYSTEM_ASSET_PROTECTED'`. Agents must use `fork_node` first.
 *
 * Note: this tool does NOT currently scan all graphs for references — that's
 * a future hardening. The delete is irreversible and any graph that referenced
 * the node will fail to compile until updated.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface DeleteNodeArgs {
  nodeId: string;
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

const deleteNodeTool: NativeToolDefinition = {
  description:
    'Permanently delete a node. REFUSES system nodes (isSystem: true) — fork them first via fork_node and delete the user-owned fork instead. Destructive: any graph referencing this node will fail to compile until updated.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: {
        type: 'string',
        description: 'The nodeId of the node to delete.',
      },
    },
    required: ['nodeId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<DeleteNodeArgs>;
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
    const headers = buildHeaders(context);

    // Step 1 — Peek at the node to check isSystem before attempting delete.
    const peekUrl = `${baseUrl}/api/v1/nodes/${encodeURIComponent(nodeId)}`;
    try {
      const peekResp = await fetch(peekUrl, { headers });
      if (!peekResp.ok) {
        let errBody = '';
        try {
          errBody = await peekResp.text();
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  `Nodes API ${peekResp.status} ${peekResp.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: peekResp.status,
                code:
                  peekResp.status === 401
                    ? 'UNAUTHORIZED'
                    : peekResp.status === 403
                    ? 'FORBIDDEN'
                    : peekResp.status === 404
                    ? 'NOT_FOUND'
                    : 'UPSTREAM_ERROR',
                nodeId,
              }),
            },
          ],
          isError: true,
        };
      }
      const peek = (await peekResp.json()) as AnyObject;
      // GET /api/v1/nodes/:nodeId returns the node fields at the top level.
      const isSystem = peek?.isSystem === true;
      if (isSystem) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  'Cannot delete system asset; fork it first via fork_node and delete the user-owned fork instead.',
                code: 'SYSTEM_ASSET_PROTECTED',
                nodeId,
              }),
            },
          ],
          isError: true,
        };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message, nodeId }) },
        ],
        isError: true,
      };
    }

    // Step 2 — Actually delete.
    const url = `${baseUrl}/api/v1/nodes/${encodeURIComponent(nodeId)}`;
    try {
      const response = await fetch(url, { method: 'DELETE', headers });

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
                    : 'UPSTREAM_ERROR',
                nodeId,
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        await response.json();
      } catch {
        /* ignore */
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, nodeId }),
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

export default deleteNodeTool;
