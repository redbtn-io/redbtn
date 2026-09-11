/**
 * Get Stream Session — Native Stream Tool
 *
 * Fetches the full StreamSession doc via the webapp API
 * (`GET /api/v1/streams/:streamId/sessions/:sessionId`).
 *
 * Spec: TOOL-HANDOFF.md §4.10
 *   - inputs: sessionId (required)
 *   - output: full session doc
 *
 * The current per-session GET route is scoped under :streamId for ACL reasons
 * (viewer-or-better access on the parent stream is enforced server-side). To
 * keep the agent surface clean, this tool accepts `sessionId` alone — when no
 * `streamId` hint is provided, the tool first lists every stream the caller
 * can access and then probes each /sessions/:sessionId endpoint until the
 * session is found.
 *
 * Callers that already know the streamId can skip the discovery walk by
 * passing it explicitly via the optional `streamId` arg. This is roughly two
 * orders of magnitude faster on accounts with hundreds of streams.
 *
 * Route gap (tracked as a follow-up): adding a top-level
 * `GET /api/v1/streams/sessions/:sessionId` in the webapp would let this tool
 * become O(1). Mirrors the existing top-level `/end` route. See report.
 *
 * Auth follows the standard Bearer / X-User-Id / X-Internal-Key fallback.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import { redactSensitive } from '../../utils/redact-sensitive';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetStreamSessionArgs {
  sessionId?: string;
  /**
   * Optional fast-path hint. When known, skips the streams-list discovery walk
   * by hitting the per-stream session route directly.
   */
  streamId?: string;
  /**
   * Optional projection: list of field names or dot-separated paths to include.
   */
  fields?: string[] | string;
  /**
   * Alias for fields.
   */
  projection?: string[] | string;
}

function parseFieldList(val: unknown): string[] | null {
  if (Array.isArray(val)) {
    return val.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof val === 'string') {
    return val.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return null;
}

function applyProjection(doc: AnyObject, fields: string[]): AnyObject {
  if (!fields.length) return doc;
  const projected: AnyObject = {};
  for (const field of fields) {
    if (field.includes('.')) {
      const parts = field.split('.');
      let cur: any = doc;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in cur) {
          cur = cur[p];
        } else {
          cur = undefined;
          break;
        }
      }
      if (cur !== undefined) {
        let dest: any = projected;
        for (let i = 0; i < parts.length - 1; i++) {
          dest[parts[i]] = dest[parts[i]] || {};
          dest = dest[parts[i]];
        }
        dest[parts[parts.length - 1]] = cur;
      }
    } else if (field in doc) {
      projected[field] = doc[field];
    }
  }
  return projected;
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

/**
 * Fetch a single session by streamId+sessionId. Returns the session doc on
 * 200, null on 404, throws on transport / non-404 error.
 */
async function fetchSession(
  baseUrl: string,
  streamId: string,
  sessionId: string,
  headers: Record<string, string>,
): Promise<AnyObject | null> {
  const url =
    `${baseUrl}/api/v1/streams/${encodeURIComponent(streamId)}` +
    `/sessions/${encodeURIComponent(sessionId)}`;
  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
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
  return (data?.session ?? null) as AnyObject | null;
}

/**
 * Discovery walk: list all streams the caller can access and probe each one's
 * sessions endpoint. Returns the first match. Capped to the first page of
 * streams (limit=100 is the route maximum) so accounts with thousands of
 * streams degrade predictably rather than hanging.
 */
async function findSessionByWalk(
  baseUrl: string,
  sessionId: string,
  headers: Record<string, string>,
): Promise<AnyObject | null> {
  // 1. List streams.
  const streamsUrl = `${baseUrl}/api/v1/streams?limit=100`;
  const listRes = await fetch(streamsUrl, { headers });
  if (!listRes.ok) {
    let body = '';
    try {
      body = await listRes.text();
    } catch {
      /* ignore */
    }
    throw new Error(
      `Streams API ${listRes.status} ${listRes.statusText}` +
        (body ? `: ${body.slice(0, 200)}` : ''),
    );
  }
  const listBody = (await listRes.json()) as AnyObject;
  const streams = Array.isArray(listBody?.streams)
    ? (listBody.streams as AnyObject[])
    : [];

  // 2. Probe each stream sequentially. Sequential — concurrent probes would
  //    burn quota for nothing; the typical case is one or two streams active
  //    at any time.
  for (const s of streams) {
    const sId = typeof s.streamId === 'string' ? s.streamId : null;
    if (!sId) continue;
    try {
      const session = await fetchSession(baseUrl, sId, sessionId, headers);
      if (session) return session;
    } catch {
      // Per-stream failures (e.g. ACL flips during the walk) shouldn't abort
      // the whole search — keep going.
      continue;
    }
  }
  return null;
}

const getStreamSessionTool: NativeToolDefinition = {
  description:
    'Fetch the full doc for a single live stream session (status, timing, runIds, logs, error, end reason, etc.). Use to inspect what state a session is in before deciding whether to end it, or after invoking start_stream_session to verify warm-up succeeded.',
  server: 'stream',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The sessionId of the session to fetch.',
      },
      streamId: {
        type: 'string',
        description:
          'Optional fast-path hint — the streamId that owns this session. When provided, skips the streams-list discovery walk entirely.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional projection: list of field names or dot-separated paths to include in the returned session object.',
      },
      projection: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Alias for fields. Optional list of field names or dot-separated paths to include.',
      },
    },
    required: ['sessionId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetStreamSessionArgs>;
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
    const streamIdHint =
      typeof args.streamId === 'string' && args.streamId.trim()
        ? args.streamId.trim()
        : undefined;

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
    const headers = buildHeaders(context);

    try {
      let session: AnyObject | null = null;

      if (streamIdHint) {
        // Fast path — caller already knows the streamId.
        session = await fetchSession(baseUrl, streamIdHint, sessionId, headers);
      } else {
        // Discovery walk.
        session = await findSessionByWalk(baseUrl, sessionId, headers);
      }

      if (!session) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'session_not_found',
                sessionId,
              }),
            },
          ],
          isError: true,
        };
      }

      const requestedFields =
        parseFieldList(args.fields) ?? parseFieldList(args.projection);
      let sessionResult: AnyObject = session;
      if (requestedFields && requestedFields.length > 0) {
        sessionResult = applyProjection(session, requestedFields);
      }
      sessionResult = redactSensitive(sessionResult);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ session: sessionResult }),
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

export default getStreamSessionTool;
module.exports = getStreamSessionTool;
