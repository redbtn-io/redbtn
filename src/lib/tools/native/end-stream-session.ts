/**
 * End Stream Session — Native Stream Tool
 *
 * Ends a live stream session via the webapp API
 * (`POST /api/v1/streams/sessions/:sessionId/end`).
 *
 * Spec: TOOL-HANDOFF.md §4.10
 *   - inputs: sessionId (required)
 *   - output: { ok: true, finalStatus: 'ended' | 'draining' }
 *
 * Lifecycle nuance: ending a session transitions it to `draining` first; the
 * stream session manager finishes the actual provider-disconnect / DB-finalize
 * dance asynchronously and flips the doc to `ended`. The /end route only
 * persists `draining` synchronously — it does NOT block on teardown. This tool
 * mirrors that contract: the `finalStatus` we return reflects what the API
 * stored at the moment of the request, which will normally be `'draining'`.
 *
 * Idempotency: the route returns 200 if the session is already draining, and
 * 409 if it's already terminal (`ended` / `error`). We surface the 409 as
 * `isError: true` with `code: 'SESSION_TERMINAL'` so callers can distinguish
 * "I tried to end a session that was already done" from a transport failure.
 *
 * Auth follows the standard Bearer / X-User-Id / X-Internal-Key fallback used
 * by the rest of the native API tools. Owner-level access is enforced by the
 * route.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface EndStreamSessionArgs {
  sessionId?: string;
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

const endStreamSessionTool: NativeToolDefinition = {
  description:
    'End a live stream session early. Use to deactivate a session that\'s no longer needed — kills the active conversation and closes provider connections. Returns the persisted lifecycle status (typically "draining"; the manager finishes teardown asynchronously and the session eventually flips to "ended").',
  server: 'stream',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description:
          'The sessionId of the live session to end. Owner-level access on the parent stream is required.',
      },
    },
    required: ['sessionId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<EndStreamSessionArgs>;
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';

    if (!sessionId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'sessionId is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url =
      `${baseUrl}/api/v1/streams/sessions/${encodeURIComponent(sessionId)}/end`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
      });

      // Already-terminal sessions surface as 409 — distinguish from transport
      // errors so callers can branch on this case.
      if (response.status === 409) {
        let errBody: AnyObject = {};
        try {
          errBody = (await response.json()) as AnyObject;
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  errBody?.error?.message ??
                  'Session is already terminal and cannot be ended.',
                code: 'SESSION_TERMINAL',
                status: 409,
                sessionId,
              }),
            },
          ],
          isError: true,
        };
      }

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
                sessionId,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const session = (data?.session ?? {}) as AnyObject;

      // The route persists `'draining'` synchronously; the manager flips to
      // `'ended'` later. Forward whatever the API actually wrote so callers
      // can observe the real state instead of a guessed one.
      const finalStatus =
        typeof session.status === 'string' ? session.status : 'draining';

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              finalStatus,
              sessionId: session.sessionId ?? sessionId,
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
            text: JSON.stringify({ error: message, sessionId }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default endStreamSessionTool;
module.exports = endStreamSessionTool;
