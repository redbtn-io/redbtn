/**
 * Start Stream Session — Native Stream Tool
 *
 * Spawns a new live session for a stream via the webapp API
 * (`POST /api/v1/streams/:streamId/sessions`).
 *
 * Spec: TOOL-HANDOFF.md §4.10
 *   - inputs: streamId (required), metadata? (object — forwarded as triggerData)
 *   - output: { sessionId, streamId, status: 'warming' }
 *
 * The webapp route returns the freshly-created session in `status: 'queued'`
 * (the stream session manager subsequently transitions it through warming →
 * active). The spec advertises `'warming'` as the headline status; we forward
 * whatever the API actually returned so callers can observe the real lifecycle
 * stage instead of a stale snapshot.
 *
 * Note on `metadata`:
 *   The current webapp POST route stores caller-provided metadata under the
 *   `triggerData` field on the StreamSession doc. We forward `metadata` as
 *   `triggerData` so the conventional native-tool input name maps onto the
 *   route's existing storage shape without requiring a follow-up server change.
 *
 * Auth follows the standard Bearer / X-User-Id / X-Internal-Key fallback used
 * by the rest of the native API tools.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface StartStreamSessionArgs {
  streamId?: string;
  metadata?: Record<string, unknown>;
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

const startStreamSessionTool: NativeToolDefinition = {
  description:
    'Start a new live session for a stream. Use to manually warm up a stream (chat, voice, websocket, etc.) when an automation, agent, or operator needs to drive it on demand. Returns the new sessionId so the caller can later fetch state or end the session.',
  server: 'stream',
  inputSchema: {
    type: 'object',
    properties: {
      streamId: {
        type: 'string',
        description:
          'The streamId of an enabled stream the caller owns. Owner-level access is required because session creation spends the owner\'s resources.',
      },
      metadata: {
        type: 'object',
        description:
          'Optional metadata bag forwarded to the session as triggerData. Free-form JSON — useful for tagging the session with the upstream cause (e.g. {"source": "agent", "issueId": "OPS-42"}).',
      },
    },
    required: ['streamId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<StartStreamSessionArgs>;
    const streamId = typeof args.streamId === 'string' ? args.streamId.trim() : '';
    const metadata =
      args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
        ? args.metadata
        : undefined;

    if (!streamId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'streamId is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    if (args.metadata !== undefined && metadata === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'metadata, when provided, must be a plain object',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/streams/${encodeURIComponent(streamId)}/sessions`;

    const body: AnyObject = {};
    if (metadata !== undefined) body.triggerData = metadata;

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
                  `Streams API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
                streamId,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const session = (data?.session ?? {}) as AnyObject;

      // Forward `sessionId` from either the wrapper or the inner session doc.
      const sessionId =
        typeof data?.sessionId === 'string'
          ? data.sessionId
          : typeof session.sessionId === 'string'
            ? session.sessionId
            : null;

      // The server reports `queued` immediately after create; the spec advertises
      // `warming` as the headline status. Forward the real value so callers see
      // the actual lifecycle stage rather than a stale snapshot.
      const status =
        typeof session.status === 'string' ? session.status : 'warming';

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              sessionId,
              streamId: session.streamId ?? streamId,
              status,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: message, streamId }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default startStreamSessionTool;
module.exports = startStreamSessionTool;
