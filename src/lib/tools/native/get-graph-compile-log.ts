/**
 * Get Graph Compile Log — Native Platform Pack Tool
 *
 * Returns the most recent compile-attempt diagnostics for a graph by proxying
 * to the webapp endpoint `GET /api/v1/graphs/:graphId/compile-log`.
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §2 Phase C + §3.1
 *
 *   - inputs:  { graphId: string, limit?: number }
 *   - output:  {
 *                logs: Array<{
 *                  compiledAt: string;
 *                  status: 'valid' | 'errors' | 'warnings';
 *                  errors: ValidationIssue[];
 *                  warnings: ValidationIssue[];
 *                  durationMs?: number;
 *                  trigger?: 'create' | 'update' | 'manual';
 *                }>;
 *                lastCompiledAt: string | null;
 *              }
 *
 * Used by an agent in the closed-loop iteration recipe (PLATFORM-PACK §5):
 * after `create_graph` / `update_graph`, fetch the log to see exactly what
 * the validator flagged on the most recent persist.
 *
 * Supersedes the Phase A stub of the same name (the stub returned
 * NOT_IMPLEMENTED).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetGraphCompileLogArgs {
  graphId?: string;
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

const getGraphCompileLogTool: NativeToolDefinition = {
  description:
    "Fetch the most recent compile-attempt diagnostics for a graph (errors + warnings + lastCompiledAt). Use to debug a failing graph in the closed-loop iteration recipe — call this AFTER create_graph / update_graph to inspect what the validator flagged. Returns { logs[], lastCompiledAt }; each log entry has { compiledAt, status, errors[], warnings[], durationMs?, trigger? }.",
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'The graphId to fetch compile diagnostics for.',
      },
      limit: {
        type: 'number',
        description:
          'Maximum number of historical attempts to return (default: 10, max: 50). Most recent first.',
        minimum: 1,
        maximum: 50,
      },
    },
    required: ['graphId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetGraphCompileLogArgs>;
    const graphId = typeof args.graphId === 'string' ? args.graphId.trim() : '';
    const limit =
      typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(50, Math.floor(args.limit)))
        : undefined;

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
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    const url = `${baseUrl}/api/v1/graphs/${encodeURIComponent(graphId)}/compile-log${qs}`;

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
                  `Compile log API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
                graphId,
                code:
                  response.status === 401
                    ? 'UNAUTHORIZED'
                    : response.status === 403
                      ? 'FORBIDDEN'
                      : response.status === 404
                        ? 'NOT_FOUND'
                        : 'UPSTREAM_ERROR',
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      // The endpoint returns { logs: [...], lastCompiledAt }. Pass-through.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              logs: Array.isArray(data?.logs) ? data.logs : [],
              lastCompiledAt: data?.lastCompiledAt ?? null,
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

export default getGraphCompileLogTool;
module.exports = getGraphCompileLogTool;
