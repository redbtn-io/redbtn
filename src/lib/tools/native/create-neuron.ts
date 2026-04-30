/**
 * Create Neuron — Native Platform Tool
 *
 * Creates a new neuron (LLM endpoint config) via the webapp API
 * (`POST /api/v1/neurons`).
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.3
 *   - inputs: neuronId? (string), config: NeuronConfig
 *   - output: { neuronId, createdAt }
 *
 * NeuronConfig: { name, provider (ollama|openai|anthropic|google|custom),
 * model, endpoint?, apiKey?, temperature?, maxTokens?, topP?,
 * audioOptimized?, role?, description?, tags? }.
 *
 * The webapp encrypts apiKey at rest with the shared ENCRYPTION_KEY.
 * Per-user limit: 20 neurons.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface CreateNeuronArgs {
  neuronId?: string;
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

const createNeuronTool: NativeToolDefinition = {
  description:
    'Create a new neuron (LLM endpoint config). Wraps an LLM provider (Ollama/OpenAI/Anthropic/Google/custom) with model selection and inference parameters. Used by graph nodes via neuron step type.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      neuronId: {
        type: 'string',
        description:
          'Optional custom neuronId. When omitted, the server generates one.',
      },
      config: {
        type: 'object',
        description:
          'NeuronConfig: { name (required), provider (required: ollama|openai|anthropic|google|custom), model (required), endpoint?, apiKey?, temperature? (default 0.7), maxTokens? (default 4096), topP?, audioOptimized?, role? (chat|worker|specialist), description?, tags? }.',
      },
    },
    required: ['config'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<CreateNeuronArgs>;
    const config = args.config && typeof args.config === 'object' ? args.config : null;
    const neuronId = typeof args.neuronId === 'string' ? args.neuronId.trim() : undefined;

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
    const url = `${baseUrl}/api/v1/neurons`;

    const body: AnyObject = { ...config };
    if (neuronId) body.neuronId = neuronId;

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
                    : response.status === 429
                    ? 'LIMIT_EXCEEDED'
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
              neuronId: data?.neuronId ?? null,
              name: data?.name ?? null,
              provider: data?.provider ?? null,
              model: data?.model ?? null,
              role: data?.role ?? null,
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

export default createNeuronTool;
