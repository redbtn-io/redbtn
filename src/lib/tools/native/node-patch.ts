/**
 * Node Patch — Native Tool
 *
 * Apply a JSON-patch-style ops list to a universal-node config WITHOUT
 * re-transmitting the full document. Proxies to the webapp API
 * (`PATCH /api/v1/nodes/:nodeId/patch`), which:
 *
 *   - restricts ops to safe subtrees (`/steps`, `/name`, `/description`,
 *     `/tags`, `/parameters`, `/metadata`, `/isPublic`),
 *   - validates that the patched `steps[]` array still contains only
 *     valid step types (`neuron`, `tool`, `transform`, `conditional`,
 *     `loop`, `delay`, `connection`, `graph`),
 *   - refuses to patch system / immutable nodes (fork first).
 *
 * Inputs:
 *   - nodeId (required, string)
 *   - ops    (required, array of patch operations, max 100)
 *
 * Output: `{ success, nodeId, value, appliedOps }` from the webapp.
 *
 * Per-step-type field requirements (e.g. neuron step must have neuronId)
 * are NOT enforced — the runtime executor surfaces those at invocation
 * time, and pre-emptive enforcement would block legitimate partial-edit
 * workflows where an agent patches a step in two passes.
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

interface NodePatchArgs {
  nodeId: string;
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
    content: [{ type: 'text', text: JSON.stringify({ error: message, code: 'VALIDATION' }) }],
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

const nodePatchTool: NativeToolDefinition = {
  description:
    'Apply a JSON-patch ops list to a universal-node config WITHOUT re-transmitting the full document. ' +
    "Use to mutate a small portion of a node (e.g. change one step's prompt, append a step, rename) " +
    'instead of re-sending all steps via update_node. Ops can only target safe subtrees: /steps, /name, ' +
    '/description, /tags, /parameters, /metadata, /isPublic. Identity, ownership, and privilege fields ' +
    '(nodeId, userId, isSystem, isImmutable) cannot be patched. The patched steps[] array must still ' +
    'contain only valid step types (neuron, tool, transform, conditional, loop, delay, connection, ' +
    'graph) — invalid types are rejected with HTTP 422 and the node is NOT modified. Per-step-type ' +
    'field requirements (e.g. neuronId on neuron steps) are NOT pre-validated; the runtime executor ' +
    'surfaces those at invocation. Refuses to patch system or immutable nodes (fork first).',
  server: 'nodes',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: {
        type: 'string',
        description: "The node's nodeId (not the Mongo _id). Caller must have owner role.",
      },
      ops: {
        type: 'array',
        description:
          'Ordered list of patch operations. Applied left-to-right; each op sees the cumulative ' +
          'result of earlier ops. Max 100 ops per call. Paths use RFC 6901 JSON Pointer syntax ' +
          'rooted at the node config (e.g. "/steps/2/systemPrompt").',
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
              description: 'JSON Pointer (RFC 6901) rooted at the node config.',
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
    required: ['nodeId', 'ops'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<NodePatchArgs>;
    const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';

    if (!nodeId) return validationError('nodeId is required and must be a non-empty string');

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
    const url = `${baseUrl}/api/v1/nodes/${encodeURIComponent(nodeId)}/patch`;

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
                  `Node patch API ${response.status} ${response.statusText}`,
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

export default nodePatchTool;
module.exports = nodePatchTool;
