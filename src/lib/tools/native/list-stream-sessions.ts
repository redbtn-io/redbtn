/**
 * List Stream Sessions — Native Stream Tool
 *
 * Lists stream sessions via the webapp API
 * (`GET /api/v1/streams/:streamId/sessions`).
 *
 * Spec: TOOL-HANDOFF.md §4.10
 *   - inputs: streamId? (optional), status? (filter), limit? (default 50)
 *   - output: { sessions: [...] }
 *
 * The webapp's session-listing route is scoped under :streamId (sessions are
 * a child collection of a stream, and ACL is enforced at the stream level).
 *
 *   - When `streamId` is provided, the tool issues a single GET against that
 *     stream's sessions route — fast path.
 *   - When `streamId` is omitted, the tool first lists every stream the
 *     caller can access (the route returns owned + shared + public + system
 *     streams), then fans out to each stream's sessions endpoint and merges
 *     the results. Sessions are then re-sorted by startedAt desc and capped
 *     at `limit`.
 *
 * Route gap (tracked as a follow-up): a top-level `GET /api/v1/sessions` (or
 * a multi-stream variant of the existing /sessions route) would let this tool
 * become O(1). The current fan-out is bounded — streams list is capped at the
 * route maximum (limit=100) and each per-stream call is awaited sequentially
 * with status passed through as a query param so the server still does the
 * filtering, not the client.
 *
 * Auth follows the standard Bearer / X-User-Id / X-Internal-Key fallback.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

type SessionStatus =
  | 'queued'
  | 'warming'
  | 'active'
  | 'draining'
  | 'ended'
  | 'error';

const VALID_STATUSES: SessionStatus[] = [
  'queued',
  'warming',
  'active',
  'draining',
  'ended',
  'error',
];

interface ListStreamSessionsArgs {
  streamId?: string;
  status?: SessionStatus;
  limit?: number;
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

async function fetchSessions(
  baseUrl: string,
  streamId: string,
  status: string | undefined,
  limit: number,
  headers: Record<string, string>,
): Promise<AnyObject[]> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (status) params.set('status', status);
  const url =
    `${baseUrl}/api/v1/streams/${encodeURIComponent(streamId)}` +
    `/sessions?${params.toString()}`;

  const response = await fetch(url, { headers });
  if (response.status === 404) return [];
  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    throw new Error(
      `Streams API ${response.status} ${response.statusText}` +
        (body ? `: ${body.slice(0, 200)}` : ''),
    );
  }
  const data = (await response.json()) as AnyObject;
  return Array.isArray(data?.sessions) ? (data.sessions as AnyObject[]) : [];
}

function parseSortKey(s: AnyObject): number {
  // startedAt is the canonical ordering field; fall back to createdAt then 0.
  const v = s.startedAt ?? s.createdAt ?? null;
  if (!v) return 0;
  const n = new Date(v as string | number | Date).getTime();
  return Number.isFinite(n) ? n : 0;
}

const listStreamSessionsTool: NativeToolDefinition = {
  description:
    'List stream sessions, optionally filtered by stream and status. Use to enumerate active or recent sessions across one or all of the caller\'s streams (e.g. "show me every active voice session" or "show me the last 20 ended sessions for stream X"). When streamId is omitted the search fans out across every stream the caller can access.',
  server: 'stream',
  inputSchema: {
    type: 'object',
    properties: {
      streamId: {
        type: 'string',
        description:
          'Optional — limit results to a single stream. When omitted, sessions from every stream the caller can access are merged together.',
      },
      status: {
        type: 'string',
        description:
          'Optional status filter. One of: queued, warming, active, draining, ended, error. Server-side filter — the API does the work, not the client.',
        enum: VALID_STATUSES,
      },
      limit: {
        type: 'integer',
        description:
          'Maximum number of sessions to return (default 50, max 100). When fanning out across multiple streams the limit is applied to the merged + re-sorted list.',
        minimum: 1,
        maximum: 100,
      },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ListStreamSessionsArgs>;

    const streamId =
      typeof args.streamId === 'string' && args.streamId.trim()
        ? args.streamId.trim()
        : undefined;

    const status =
      typeof args.status === 'string' && VALID_STATUSES.includes(args.status as SessionStatus)
        ? args.status
        : undefined;

    if (args.status !== undefined && status === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                `status, when provided, must be one of: ${VALID_STATUSES.join(', ')}`,
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const limit =
      args.limit !== undefined && Number.isFinite(Number(args.limit))
        ? Math.min(100, Math.max(1, Math.floor(Number(args.limit))))
        : 50;

    const baseUrl = getBaseUrl();
    const headers = buildHeaders(context);

    try {
      let sessions: AnyObject[] = [];

      if (streamId) {
        // Fast path — single stream.
        sessions = await fetchSessions(baseUrl, streamId, status, limit, headers);
      } else {
        // Fan-out path — list streams, then fetch sessions for each.
        const streamsUrl = `${baseUrl}/api/v1/streams?limit=100`;
        const listRes = await fetch(streamsUrl, { headers });
        if (!listRes.ok) {
          let body = '';
          try {
            body = await listRes.text();
          } catch {
            /* ignore */
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error:
                    `Streams API ${listRes.status} ${listRes.statusText}` +
                    (body ? `: ${body.slice(0, 200)}` : ''),
                  status: listRes.status,
                }),
              },
            ],
            isError: true,
          };
        }
        const listBody = (await listRes.json()) as AnyObject;
        const streams = Array.isArray(listBody?.streams)
          ? (listBody.streams as AnyObject[])
          : [];

        const merged: AnyObject[] = [];
        for (const s of streams) {
          const sId = typeof s.streamId === 'string' ? s.streamId : null;
          if (!sId) continue;
          try {
            const perStream = await fetchSessions(baseUrl, sId, status, limit, headers);
            for (const sess of perStream) merged.push(sess);
          } catch {
            // Per-stream failure shouldn't abort the whole search.
            continue;
          }
        }
        sessions = merged;
      }

      // Re-sort merged results by startedAt desc + cap at limit.
      sessions.sort((a, b) => parseSortKey(b) - parseSortKey(a));
      sessions = sessions.slice(0, limit);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ sessions }),
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

export default listStreamSessionsTool;
module.exports = listStreamSessionsTool;
