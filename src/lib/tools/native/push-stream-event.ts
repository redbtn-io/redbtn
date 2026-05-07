/**
 * Push Stream Event — Native Tool
 *
 * Publishes an ephemeral status event to a Stream session's UI without
 * persisting anything to conversation history. Use when a graph or
 * automation wants the originating Stream's UI to react live (progress
 * indicators, partial findings, "thinking…" status, etc.) but the data
 * doesn't belong in the chat record.
 *
 * Distinct from:
 *   - `push_message`         — writes to conversation history (sticks).
 *   - `store_message`        — same persistent layer, write-only.
 *   - The run's terminal     — `run_complete` returns the final result;
 *     event channel              this tool is for status BEFORE that.
 *
 * Wire path: tool → webapp `/api/v1/internal/stream-events` →
 *   PUBLISH stream:event:<sessionId> → session-manager subscriber →
 *   sessionBroadcast → user WebSocket. Nothing persisted.
 *
 * Auth: same internal-key fallback as other state tools.
 *
 * Auto-resolution of sessionId: if `sessionId` is omitted, the tool tries
 *   - state.data.input.sessionId          (set by stream-tool dispatch)
 *   - state.data._trigger?.metadata?.sessionId
 *   - state.sessionId
 *   in that order. Pass an explicit value to override.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface PushStreamEventArgs {
  sessionId?: string;
  type?: string;
  payload?: Record<string, unknown>;
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

function resolveSessionId(
  args: Partial<PushStreamEventArgs>,
  context: NativeToolContext,
): string | undefined {
  const fromArgs = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (fromArgs) return fromArgs;

  const state = context?.state as AnyObject | undefined;
  const fromInput = state?.data?.input?.sessionId;
  if (typeof fromInput === 'string' && fromInput) return fromInput;

  const fromTrigger =
    state?.data?._trigger?.metadata?.sessionId ??
    state?._trigger?.metadata?.sessionId;
  if (typeof fromTrigger === 'string' && fromTrigger) return fromTrigger;

  const fromState = state?.sessionId;
  if (typeof fromState === 'string' && fromState) return fromState;

  return undefined;
}

const pushStreamEventTool: NativeToolDefinition = {
  description:
    "Push an ephemeral status event to the originating Stream session's UI without writing to conversation history. Useful for progress indicators, partial findings, or 'thinking…' status updates that should be live but not persisted.",
  server: 'streams',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description:
          "The target Stream session ID. Optional — defaults to the session that triggered the current run (resolved from state.data.input.sessionId / trigger metadata).",
      },
      type: {
        type: 'string',
        description:
          "Event type — drives client-side dispatch. Defaults to 'stream_event'. Use distinct types per producer (e.g. 'progress', 'finding', 'tool_status').",
      },
      payload: {
        type: 'object',
        description:
          'Free-form payload for the UI. Spread into the broadcast event alongside `type` and `ts`.',
        additionalProperties: true,
      },
    },
    required: [],
  },

  async handler(
    rawArgs: AnyObject,
    context: NativeToolContext,
  ): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<PushStreamEventArgs>;
    const sessionId = resolveSessionId(args, context);

    if (!sessionId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                'sessionId could not be resolved (no arg, no state.data.input.sessionId, no trigger metadata)',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const eventType =
      typeof args.type === 'string' && args.type.trim()
        ? args.type.trim()
        : 'stream_event';
    const payload =
      args.payload && typeof args.payload === 'object' ? args.payload : undefined;

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/internal/stream-events`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
        body: JSON.stringify({ sessionId, type: eventType, payload }),
      });

      if (!response.ok) {
        let body = '';
        try {
          body = await response.text();
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  `stream-events API ${response.status} ${response.statusText}` +
                  (body ? `: ${body.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, sessionId, type: eventType }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default pushStreamEventTool;
module.exports = pushStreamEventTool;
