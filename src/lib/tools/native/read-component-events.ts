/**
 * Read Component Events — Native Tool (chat-interactive-widgets phase 10).
 *
 * Drains the per-run component-event inbox. Each event is a JSON object
 * with `componentId`, `payload`, optional `messageId` + `userId`, and a
 * `timestamp`. See `ComponentInteractionEvent` in
 * `lib/run/run-publisher.ts`.
 *
 * Usage in a node config:
 *
 *   { "type": "tool", "config": {
 *       "toolName": "read_component_events",
 *       "parameters": { "peek": false },
 *       "outputField": "data.componentEvents"
 *   } }
 *
 * After execution, `state.data.componentEvents` holds the drained event
 * array. The graph can branch on `length`, filter on `componentId`, or
 * deep-read `payload` to react to the user's interaction.
 *
 * The tool prefers calling the webapp endpoint
 * `GET /api/v1/runs/:runId/component-event` (which enforces auth +
 * ownership in one place) when WEBAPP_URL is set; falls back to a direct
 * Redis read via `drainRunComponentEvents` when the engine is running
 * worker-local with no webapp around. Both paths are equivalent.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import { drainRunComponentEvents } from '../../run/run-publisher';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ReadArgs {
  /** When true, returns events without clearing the inbox. Default false. */
  peek?: boolean;
  /** Override the runId (otherwise pulled from context.runId). */
  runId?: string;
}

function getBaseUrl(): string | null {
  return process.env.WEBAPP_URL || null;
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

const readComponentEventsTool: NativeToolDefinition = {
  description:
    'Drain the per-run component-event inbox. Returns the queued ComponentInteractionEvent payloads published by clients via POST /api/v1/runs/:runId/component-event. Pass peek:true to read without clearing. RunId defaults to the active run.',
  server: 'system',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      peek: {
        type: 'boolean',
        description:
          'When true, returns events but leaves the inbox intact for the next drain. Defaults to false (drain semantics).',
        default: false,
      },
      runId: {
        type: 'string',
        description:
          'Override the active runId. Defaults to context.runId — almost never needed.',
      },
    },
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = (rawArgs ?? {}) as ReadArgs;
    const peek = args.peek === true;
    const abortSignal = context?.abortSignal ?? null;
    const runId = (typeof args.runId === 'string' && args.runId.trim().length > 0)
      ? args.runId.trim()
      : (context?.runId ?? null);

    if (!runId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'runId is required (no active run in context)', code: 'VALIDATION' }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    if (baseUrl) {
      if (abortSignal?.aborted) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'read_component_events: operation already aborted', code: 'ABORTED' }) }],
          isError: true,
        };
      }
      // Preferred path: round-trip through the webapp endpoint so auth +
      // ownership enforcement lives in one place.
      try {
        const url = `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/component-event${peek ? '?peek=1' : ''}`;
        const res = await fetch(url, {
          method: 'GET',
          headers: buildHeaders(context),
          signal: abortSignal ?? undefined,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `read_component_events: HTTP ${res.status}`, status: res.status, body }),
              },
            ],
            isError: true,
          };
        }
        const json = await res.json().catch(() => null) as { events?: unknown[] } | null;
        const events = Array.isArray(json?.events) ? json!.events : [];
        return {
          content: [{ type: 'text', text: JSON.stringify({ runId, events, peek, count: events.length }) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `read_component_events: ${msg}` }) }],
          isError: true,
        };
      }
    }

    // Fallback path — direct Redis drain. Used when running the engine
    // standalone (no webapp / WEBAPP_URL). Pulls the redis client off the
    // publisher (which is the same client the engine uses for everything).
    const publisher = context.publisher as unknown as { redis?: unknown } | null;
    const redis = publisher?.redis ?? null;
    if (!redis) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'no redis client available (set WEBAPP_URL or run under a publisher context)', code: 'CONFIG' }),
          },
        ],
        isError: true,
      };
    }
    if (abortSignal?.aborted) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'read_component_events: operation already aborted', code: 'ABORTED' }) }],
        isError: true,
      };
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events = await drainRunComponentEvents(redis as any, runId, { peek });
      return {
        content: [{ type: 'text', text: JSON.stringify({ runId, events, peek, count: events.length }) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `read_component_events: ${msg}` }) }],
        isError: true,
      };
    }
  },
};

export default readComponentEventsTool;
module.exports = readComponentEventsTool;
