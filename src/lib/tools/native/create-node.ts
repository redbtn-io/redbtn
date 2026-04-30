/**
 * Create Node — Native Platform Tool
 *
 * Creates a new universal node config via the webapp API
 * (`POST /api/v1/nodes`).
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.2
 *   - inputs: nodeId? (string), config: NodeConfig (must include steps[])
 *   - output: { nodeId, createdAt }
 *
 * NodeConfig shape: { name (required), description?, steps: Step[],
 * metadata?, parameters?, isPublic?, isParser?, parserConfig?, tags? }
 *
 * Step types: neuron | tool | transform | conditional | loop | connection |
 * delay | graph. See PLATFORM-PACK-HANDOFF.md §2 for the full reference.
 *
 * Private nodes (isPublic: false) require PRO tier or better; the webapp
 * silently coerces to isPublic: true for FREE/BASIC users.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface CreateNodeArgs {
  nodeId?: string;
  config: AnyObject;
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

const createNodeTool: NativeToolDefinition = {
  description:
    'Create a new universal node configuration. A node is a sequence of steps (neuron/tool/transform/conditional/loop/connection/delay/graph) executed by the universal node runtime. Use this to build reusable workflow building blocks.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: {
        type: 'string',
        description:
          'Optional custom nodeId. When omitted, the server generates one. Use lowercase letters, numbers, and hyphens.',
      },
      config: {
        type: 'object',
        description:
          'NodeConfig: { name (required), description?, steps: Step[] (required for non-parser), metadata? { icon, color, inputs, outputs }, parameters?, isPublic? (default true; private requires PRO), isParser?, parserConfig?, tags? }.',
      },
    },
    required: ['config'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<CreateNodeArgs>;
    const config = args.config && typeof args.config === 'object' ? args.config : null;
    const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : undefined;

    if (!config) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'config is required and must be an object',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/nodes`;

    const body: AnyObject = { ...config };
    if (nodeId) body.nodeId = nodeId;

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
                    : response.status === 409
                    ? 'CONFLICT'
                    : 'UPSTREAM_ERROR',
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
              name: data?.name ?? null,
              stepsCount: data?.stepsCount ?? null,
              createdAt: data?.createdAt ?? null,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message }) },
        ],
        isError: true,
      };
    }
  },
};

export default createNodeTool;
