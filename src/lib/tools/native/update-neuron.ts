/**
 * Update Neuron — Native Platform Tool
 *
 * Patches an existing neuron config (PATCH /api/v1/neurons/:neuronId).
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.3
 *   - inputs: neuronId (required), patch
 *   - output: { ok: true }
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface UpdateNeuronArgs {
  neuronId: string;
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

const updateNeuronTool: NativeToolDefinition = {
  description:
    'Update an existing neuron config (PATCH). Patch fields are optional. Use to tune temperature/maxTokens, swap models, or update API key.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      neuronId: {
        type: 'string',
        description: 'The neuronId of the neuron to update.',
      },
      patch: {
        type: 'object',
        description:
          'Partial NeuronConfig: name?, description?, provider?, endpoint?, model?, apiKey?, temperature?, maxTokens?, topP?, audioOptimized?, role?, tags?.',
      },
    },
    required: ['neuronId', 'patch'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<UpdateNeuronArgs>;
    const neuronId = typeof args.neuronId === 'string' ? args.neuronId.trim() : '';
    const patch = args.patch && typeof args.patch === 'object' ? args.patch : null;

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
    const url = `${baseUrl}/api/v1/neurons/${encodeURIComponent(neuronId)}`;

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
              ok: true,
              neuronId: data?.neuronId ?? neuronId,
              name: data?.name ?? null,
              updatedAt: data?.updatedAt ?? null,
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

export default updateNeuronTool;
