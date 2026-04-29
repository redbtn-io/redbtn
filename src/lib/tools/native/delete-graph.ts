/**
 * Delete Graph — Native Platform Tool
 *
 * Permanently deletes a user-owned graph via the webapp API
 * (`DELETE /api/v1/graphs/:graphId`).
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.1
 *   - inputs: graphId (required)
 *   - output: { ok: true } — refuses if isSystem
 *
 * SAFETY: Before calling DELETE, this tool fetches the graph via GET to check
 * `isSystem`. If `isSystem === true` (or `userId === 'system'`), the call is
 * REFUSED with `code: 'SYSTEM_ASSET_PROTECTED'`. Agents must use `fork_graph`
 * first to get a user-owned copy.
 *
 * This is non-negotiable: system assets are the platform's own primitives;
 * destroying them would brick the system for every user.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface DeleteGraphArgs {
  graphId: string;
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

const deleteGraphTool: NativeToolDefinition = {
  description:
    'Permanently delete a graph. REFUSES system graphs (isSystem: true) — fork them first via fork_graph and delete the user-owned fork instead. Destructive: there is no undo.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'The graphId of the graph to delete.',
      },
    },
    required: ['graphId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<DeleteGraphArgs>;
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
    const headers = buildHeaders(context);

    // Step 1 — Fetch the graph to check isSystem before attempting delete.
    const peekUrl = `${baseUrl}/api/v1/graphs/${encodeURIComponent(graphId)}`;
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
                  `Graphs API ${peekResp.status} ${peekResp.statusText}` +
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
                graphId,
              }),
            },
          ],
          isError: true,
        };
      }
      const peek = (await peekResp.json()) as AnyObject;
      const graph = (peek?.graph ?? peek) as AnyObject;
      const isSystem = graph?.isSystem === true || graph?.userId === 'system';
      if (isSystem) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  'Cannot delete system asset; fork it first via fork_graph and delete the user-owned fork instead.',
                code: 'SYSTEM_ASSET_PROTECTED',
                graphId,
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
          { type: 'text', text: JSON.stringify({ error: message, graphId }) },
        ],
        isError: true,
      };
    }

    // Step 2 — Actually delete.
    const url = `${baseUrl}/api/v1/graphs/${encodeURIComponent(graphId)}`;
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

      try {
        await response.json();
      } catch {
        /* ignore */
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, graphId }),
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

export default deleteGraphTool;
module.exports = deleteGraphTool;
