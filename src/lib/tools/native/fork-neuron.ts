/**
 * Fork Neuron — Native Platform Tool
 *
 * Creates a personal copy of a neuron via the webapp API
 * (`POST /api/v1/neurons/:neuronId/fork`). Works for system, public, and
 * shared neurons.
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.3
 *   - inputs: neuronId (required), newNeuronId? (custom ID)
 *   - output: { neuronId, forkedFrom }
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ForkNeuronArgs {
  neuronId: string;
  newNeuronId?: string;
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

const forkNeuronTool: NativeToolDefinition = {
  description:
    'Fork a neuron — create a personal mutable copy. Works for system, public, and shared neurons. Use before update_neuron or delete_neuron on system assets.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      neuronId: {
        type: 'string',
        description: 'The neuronId of the neuron to fork.',
      },
      newNeuronId: {
        type: 'string',
        description:
          'Optional custom neuronId for the fork. When omitted, the server generates one.',
      },
      name: {
        type: 'string',
        description: 'Optional custom name for the fork.',
      },
    },
    required: ['neuronId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ForkNeuronArgs>;
    const neuronId = typeof args.neuronId === 'string' ? args.neuronId.trim() : '';
    const newNeuronId =
      typeof args.newNeuronId === 'string' ? args.newNeuronId.trim() : undefined;
    const name = typeof args.name === 'string' ? args.name.trim() : undefined;

    if (!neuronId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'neuronId is required', code: 'VALIDATION' }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/neurons/${encodeURIComponent(neuronId)}/fork`;

    const body: AnyObject = {};
    if (newNeuronId) body.newNeuronId = newNeuronId;
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
                  `Neurons API ${response.status} ${response.statusText}` +
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
                    : response.status === 429
                    ? 'LIMIT_EXCEEDED'
                    : 'UPSTREAM_ERROR',
                neuronId,
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
              neuronId: data?.neuronId ?? null,
              forkedFrom: data?.parentNeuronId ?? neuronId,
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
          { type: 'text', text: JSON.stringify({ error: message, neuronId }) },
        ],
        isError: true,
      };
    }
  },
};

export default forkNeuronTool;
