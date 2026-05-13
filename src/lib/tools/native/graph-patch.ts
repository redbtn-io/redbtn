/**
 * Graph Patch — Native Tool
 *
 * Apply a JSON-patch-style ops list to a graph config WITHOUT re-transmitting
 * the full document. Proxies to the webapp API
 * (`PATCH /api/v1/graphs/:graphId/patch`), which:
 *
 *   - restricts ops to a safe-subtree allowlist (`/nodes`, `/edges`,
 *     `/name`, `/description`, `/tier`, `/tags`, `/layout`, `/graphType`,
 *     `/isPublic`, `/inputSchema`, `/defaultInput`, `/provides`,
 *     `/parameters`),
 *   - rejects patches that would produce an invalid graph
 *     (`validateGraphConfig` failure → HTTP 422),
 *   - refuses to patch system / immutable graphs (fork first).
 *
 * Inputs:
 *   - graphId (required, string)
 *   - ops     (required, array of patch operations, max 100)
 *
 * Output: `{ success, graphId, value, appliedOps, validation }` from the
 * webapp endpoint, surfaced verbatim. `validation.errors` (if any) carries
 * the structured validateGraphConfig failures — read this if a 422 comes
 * back to figure out what to fix.
 *
 * Auth: same Bearer / X-User-Id / X-Internal-Key fallback pattern as the
 * other state/graph proxy tools. Caller must have OWNER role on the graph.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface PatchOp {
  op: 'set' | 'append' | 'prepend' | 'merge' | 'remove' | 'inc';
  path: string;
  value?: unknown;
}

interface GraphPatchArgs {
  graphId: string;
  ops: PatchOp[];
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

function validationError(message: string): NativeMcpResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ error: message, code: 'VALIDATION' }) },
    ],
    isError: true,
  };
}

function extractErrorMessage(data: AnyObject): string | null {
  if (typeof data.error === 'string') return data.error;
  if (data.error && typeof data.error === 'object') {
    const e = data.error as AnyObject;
    if (typeof e.message === 'string') return e.message;
  }
  if (typeof data.message === 'string') return data.message;
  return null;
}

const graphPatchTool: NativeToolDefinition = {
  description:
    'Apply a JSON-patch ops list to a graph config WITHOUT re-transmitting the full document. Use to ' +
    'mutate a small portion of a large graph (e.g. change one node\'s parameters, add an edge, rename) ' +
    'instead of re-sending all nodes/edges via update_graph. Ops can only target safe subtrees: ' +
    '/nodes, /edges, /name, /description, /tier, /tags, /layout, /graphType, /isPublic, /inputSchema, ' +
    '/defaultInput, /provides, /parameters. Identity, ownership, and privilege fields (graphId, userId, ' +
    'isSystem, isImmutable) cannot be patched. The result must still pass validateGraphConfig — if a ' +
    'patch would leave the graph invalid (orphan edges, undefined node refs, etc.) the request is ' +
    'rejected and the graph is NOT modified. Refuses to patch system or immutable graphs (fork first).',
  server: 'graphs',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'The graph\'s graphId (not the Mongo _id). Caller must have owner role.',
      },
      ops: {
        type: 'array',
        description:
          'Ordered list of patch operations. Applied left-to-right; each op sees the cumulative ' +
          'result of earlier ops. Max 100 ops per call. Paths use RFC 6901 JSON Pointer syntax ' +
          'rooted at the graph config (e.g. "/nodes/3/parameters/temperature").',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['set', 'append', 'prepend', 'merge', 'remove', 'inc'],
              description: 'Operation kind.',
            },
            path: {
              type: 'string',
              description: 'JSON Pointer (RFC 6901) rooted at the graph config.',
            },
            value: {
              description: 'Operand value. Required for set/append/prepend/merge/inc; omit for remove.',
            },
          },
          required: ['op', 'path'],
        },
        minItems: 1,
        maxItems: 100,
      },
    },
    required: ['graphId', 'ops'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GraphPatchArgs>;
    const graphId = typeof args.graphId === 'string' ? args.graphId.trim() : '';

    if (!graphId) return validationError('graphId is required and must be a non-empty string');

    if (!Array.isArray(args.ops)) {
      return validationError('ops is required and must be an array of patch operations');
    }
    if (args.ops.length === 0) {
      return validationError('ops must contain at least one operation');
    }
    if (args.ops.length > 100) {
      return validationError('ops cannot contain more than 100 operations');
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/graphs/${encodeURIComponent(graphId)}/patch`;

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: buildHeaders(context),
        body: JSON.stringify({ ops: args.ops }),
      });

      const text = await response.text();
      let data: unknown = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }

      if (!response.ok) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  (typeof data === 'object' && data !== null
                    ? extractErrorMessage(data as AnyObject)
                    : null) ||
                  `Graph patch API ${response.status} ${response.statusText}`,
                status: response.status,
                ...(typeof data === 'object' && data !== null ? { details: data } : {}),
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text:
              typeof data === 'string'
                ? data
                : JSON.stringify(data ?? { ok: true }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  },
};

export default graphPatchTool;
module.exports = graphPatchTool;
