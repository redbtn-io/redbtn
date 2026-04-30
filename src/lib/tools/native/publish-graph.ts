/**
 * Publish Graph — Native Platform Tool
 *
 * Promotes a graph's draft to published state via the webapp API
 * (`POST /api/v1/graphs/:graphId/publish`).
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.1
 *   - inputs: graphId (required)
 *   - output: { ok: true, version, publishedAt, promotedNodes }
 *
 * Publishing flattens any inline node steps into standalone node documents
 * and bumps the published version. Owner-only on the upstream route — system
 * graphs cannot be published via this endpoint.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface PublishGraphArgs {
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

const publishGraphTool: NativeToolDefinition = {
  description:
    'Publish a graph — promote its draft to the live, runnable version. Flattens inline node steps into standalone node documents and bumps the published version. Owner-only.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'The graphId of the graph to publish.',
      },
    },
    required: ['graphId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<PublishGraphArgs>;
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
    const url = `${baseUrl}/api/v1/graphs/${encodeURIComponent(graphId)}/publish`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
        body: JSON.stringify({}),
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
              isPublic: data?.isPublic ?? null,
              version: data?.version ?? null,
              publishedAt: data?.publishedAt ?? null,
              promotedNodes: Array.isArray(data?.promotedNodes) ? data.promotedNodes : [],
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

export default publishGraphTool;
