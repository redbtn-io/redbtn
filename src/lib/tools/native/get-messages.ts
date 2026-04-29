/**
 * Get Messages — Native Tool
 *
 * Fetches messages for a conversation via the webapp API
 * (`GET /api/v1/conversations/:id/messages`).
 *
 * Spec: TOOL-HANDOFF.md §4.3
 *   - inputs: conversationId (required), limit? (default 50), before? (cursor)
 *   - output: { messages: [...], hasMore }
 *
 * The webapp route accepts `limit` and `before` (epoch ms timestamp). Cursor
 * pagination uses `before` to walk backwards through history. The route
 * returns the most recent N messages within the time window so it pairs well
 * with iterative pagination from the tail.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetMessagesArgs {
  conversationId: string;
  limit?: number;
  before?: number | string; // epoch ms or numeric string
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

const getMessagesTool: NativeToolDefinition = {
  description:
    'Read messages from a conversation, newest first when paginated. Use to fetch chat history before composing a reply or summarising past discussion.',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation id to fetch messages from.',
      },
      limit: {
        type: 'integer',
        description: 'Max number of messages to return (default 50).',
        minimum: 1,
        maximum: 500,
      },
      before: {
        description:
          'Optional cursor — a timestamp in epoch milliseconds. Returns messages older than this timestamp, useful for paginating backwards through history.',
      },
    },
    required: ['conversationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetMessagesArgs>;
    const conversationId =
      typeof args.conversationId === 'string' ? args.conversationId.trim() : '';

    if (!conversationId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'conversationId is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const limit =
      args.limit !== undefined && Number.isFinite(Number(args.limit))
        ? Math.min(500, Math.max(1, Math.floor(Number(args.limit))))
        : 50;

    let beforeMs: number | null = null;
    if (args.before !== undefined && args.before !== null && args.before !== '') {
      const n = Number(args.before);
      if (!Number.isFinite(n) || n <= 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'before, when provided, must be a positive epoch ms timestamp',
                code: 'VALIDATION',
              }),
            },
          ],
          isError: true,
        };
      }
      beforeMs = Math.floor(n);
    }

    const baseUrl = getBaseUrl();
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (beforeMs !== null) params.set('before', String(beforeMs));

    const url =
      `${baseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/messages` +
      `?${params.toString()}`;

    try {
      const response = await fetch(url, { headers: buildHeaders(context) });

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
                  `Messages API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              messages: Array.isArray(data?.messages) ? data.messages : [],
              hasMore: Boolean(data?.hasMore),
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
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default getMessagesTool;
module.exports = getMessagesTool;
