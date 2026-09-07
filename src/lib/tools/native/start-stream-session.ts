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
 *
 * # Security — this tool creates a session a model chose
 *
 * A model calls it with a model-chosen `streamId` and a model-chosen
 * `metadata`, and the webapp creates a StreamSession from them. It is the same
 * family as `invoke_graph` and `trigger_automation`, so it stamps
 * `MODEL_DRIVEN_STATE_KEY` into `metadata` on the same condition: the caller's
 * own arguments were model-chosen (`untrustedCaller`), or the parent run is
 * already tainted. Stamped AFTER the caller's own metadata, so a model passing
 * `_modelDrivenArgs:false` can only add the taint, never clear it.
 *
 * **Be precise about what that buys today.** `metadata` is stored as the
 * session document's `triggerData`
 * (`webapp/src/app/api/streams/[streamId]/sessions/route.ts`), and the webapp
 * does NOT spread `triggerData` into the input of any run the session later
 * starts:
 *
 *   - a startup graph gets an input the hub builds from scratch
 *     (`session-manager.ts` `runStartupGraph`);
 *   - a stream tool call gets `call.args` (plus `_source`/`sessionId`), which
 *     come from the live model on the session's own socket, not from here;
 *   - `session.input` comes from the stream's `defaultInput` and the session
 *     creator's input, not from `triggerData`.
 *
 * So the marker is provenance on the session document and a forward guarantee
 * — the moment any of those paths starts carrying `triggerData` into a run
 * input, the taint is already there — but it is NOT, today, an active control
 * on the runs a session spawns. The live surface for those is the hub's own
 * dispatch, which is webapp-side and out of this repo. Saying otherwise is the
 * prose-overpromise the review has rejected twice; this comment exists so the
 * next reader does not have to re-derive it.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import { MODEL_DRIVEN_STATE_KEY, isModelDrivenState } from '../caller-trust';

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

    // Taint the session when this call's own arguments were model-chosen, or
    // when the parent run is already tainted. See the security note in the
    // module header — including what it does and does not reach today.
    const childIsModelDriven =
      context?.untrustedCaller === true || isModelDrivenState(context?.state);

    const body: AnyObject = {};
    if (metadata !== undefined) body.triggerData = metadata;
    if (childIsModelDriven) {
      // AFTER the caller's metadata, so `_modelDrivenArgs:false` is overwritten.
      body.triggerData = { ...(metadata ?? {}), [MODEL_DRIVEN_STATE_KEY]: true };
    }

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
