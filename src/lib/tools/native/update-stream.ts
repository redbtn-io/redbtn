/**
 * Update Stream — Native Platform Tool
 *
 * Patches an existing stream config (PATCH /api/v1/streams/:streamId).
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.4
 *   - inputs: streamId (required), patch
 *   - output: { ok: true }
 *
 * Member-level updates allow only `name`, `description`, `tags`. Anything
 * else (provider config, model swaps, tools, triggers, etc.) requires owner
 * role and surfaces as `403` from the upstream.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface UpdateStreamArgs {
  streamId: string;
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

const updateStreamTool: NativeToolDefinition = {
  description:
    'Update an existing stream config (PATCH). Patch fields are optional. Member-level patches allow only name/description/tags; everything else (providerConfig, model, tools, triggers, etc.) requires owner role.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      streamId: {
        type: 'string',
        description: 'The streamId of the stream to update.',
      },
      patch: {
        type: 'object',
        description:
          'Partial StreamConfig: name?, description?, type?, providerConfig?, graphId?, model?, voice?, systemPrompt?, tools?, toolGraphs?, triggers?, keepAlive?, startupGraphId?, teardownGraphId?, shutdownConfig?, concurrency?, maxConcurrentSessions?, inputMapping?, defaultInput?, outputParser?, inputParser?, connections?, eventHandlers?, inputSchema?, secretNames?, configOverrides?, tags?, isEnabled?.',
      },
    },
    required: ['streamId', 'patch'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<UpdateStreamArgs>;
    const streamId = typeof args.streamId === 'string' ? args.streamId.trim() : '';
    const patch = args.patch && typeof args.patch === 'object' ? args.patch : null;

    if (!streamId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'streamId is required', code: 'VALIDATION' }),
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
    const url = `${baseUrl}/api/v1/streams/${encodeURIComponent(streamId)}`;

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
                  `Streams API ${response.status} ${response.statusText}` +
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
                streamId,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const stream = (data?.stream ?? data) as AnyObject;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              streamId: stream?.streamId ?? streamId,
              name: stream?.name ?? null,
              updatedAt: stream?.updatedAt ?? null,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message, streamId }) },
        ],
        isError: true,
      };
    }
  },
};

export default updateStreamTool;
module.exports = updateStreamTool;
