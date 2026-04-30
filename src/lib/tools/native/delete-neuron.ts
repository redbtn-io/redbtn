/**
 * Delete Neuron — Native Platform Tool
 *
 * Permanently deletes a user-owned neuron via the webapp API
 * (`DELETE /api/v1/neurons/:neuronId`).
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.3
 *   - inputs: neuronId (required)
 *   - output: { ok: true } — refuses if isSystem
 *
 * SAFETY: Before calling DELETE, fetches the neuron via GET to check
 * `isSystem`. If `isSystem === true`, REFUSES with `code:
 * 'SYSTEM_ASSET_PROTECTED'`. Agents must use `fork_neuron` first.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface DeleteNeuronArgs {
  neuronId: string;
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

const deleteNeuronTool: NativeToolDefinition = {
  description:
    'Permanently delete a neuron. REFUSES system neurons (isSystem: true) — fork them first via fork_neuron and delete the user-owned fork instead.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      neuronId: {
        type: 'string',
        description: 'The neuronId of the neuron to delete.',
      },
    },
    required: ['neuronId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<DeleteNeuronArgs>;
    const neuronId = typeof args.neuronId === 'string' ? args.neuronId.trim() : '';

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
    const headers = buildHeaders(context);

    // Step 1 — Peek at the neuron to check isSystem before attempting delete.
    const peekUrl = `${baseUrl}/api/v1/neurons/${encodeURIComponent(neuronId)}`;
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
                  `Neurons API ${peekResp.status} ${peekResp.statusText}` +
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
                neuronId,
              }),
            },
          ],
          isError: true,
        };
      }
      const peek = (await peekResp.json()) as AnyObject;
      const neuron = (peek?.neuron ?? peek) as AnyObject;
      const isSystem = neuron?.isSystem === true || neuron?.userId === 'system';
      if (isSystem) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  'Cannot delete system asset; fork it first via fork_neuron and delete the user-owned fork instead.',
                code: 'SYSTEM_ASSET_PROTECTED',
                neuronId,
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
          { type: 'text', text: JSON.stringify({ error: message, neuronId }) },
        ],
        isError: true,
      };
    }

    // Step 2 — Actually delete.
    const url = `${baseUrl}/api/v1/neurons/${encodeURIComponent(neuronId)}`;
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

      try {
        await response.json();
      } catch {
        /* ignore */
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, neuronId }),
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

export default deleteNeuronTool;
