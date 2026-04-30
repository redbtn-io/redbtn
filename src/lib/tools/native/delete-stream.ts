/**
 * Delete Stream — Native Platform Tool
 *
 * Permanently deletes a user-owned stream config via the webapp API
 * (`DELETE /api/v1/streams/:streamId`).
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.4
 *   - inputs: streamId (required)
 *   - output: { ok: true } — refuses if isSystem; force-closes any active session
 *
 * SAFETY: Before calling DELETE, fetches the stream via GET to check
 * `isSystem`. If `isSystem === true`, REFUSES with `code:
 * 'SYSTEM_ASSET_PROTECTED'`. Streams have no fork API in Phase A, so the
 * remediation message asks the agent to create a new stream from scratch
 * with `create_stream` and supply the same config.
 *
 * The webapp DELETE route is responsible for force-closing any active
 * session — we just proxy the request.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface DeleteStreamArgs {
  streamId: string;
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

const deleteStreamTool: NativeToolDefinition = {
  description:
    'Permanently delete a stream config. REFUSES system streams (isSystem: true) — recreate via create_stream with your own config instead. Force-closes any active session for the deleted stream.',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      streamId: {
        type: 'string',
        description: 'The streamId of the stream to delete.',
      },
    },
    required: ['streamId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<DeleteStreamArgs>;
    const streamId = typeof args.streamId === 'string' ? args.streamId.trim() : '';

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

    const baseUrl = getBaseUrl();
    const headers = buildHeaders(context);

    // Step 1 — Peek at the stream to check isSystem before attempting delete.
    const peekUrl = `${baseUrl}/api/v1/streams/${encodeURIComponent(streamId)}`;
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
                  `Streams API ${peekResp.status} ${peekResp.statusText}` +
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
                streamId,
              }),
            },
          ],
          isError: true,
        };
      }
      const peek = (await peekResp.json()) as AnyObject;
      const stream = (peek?.stream ?? peek) as AnyObject;
      const isSystem = stream?.isSystem === true || stream?.userId === 'system';
      if (isSystem) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  'Cannot delete system asset; create your own stream via create_stream instead. Streams cannot be forked.',
                code: 'SYSTEM_ASSET_PROTECTED',
                streamId,
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
          { type: 'text', text: JSON.stringify({ error: message, streamId }) },
        ],
        isError: true,
      };
    }

    // Step 2 — Actually delete.
    const url = `${baseUrl}/api/v1/streams/${encodeURIComponent(streamId)}`;
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

      try {
        await response.json();
      } catch {
        /* ignore */
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, streamId }),
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

export default deleteStreamTool;
