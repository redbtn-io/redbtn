/**
 * List Conversations — Native Tool
 *
 * Lists conversations the caller can see (owned + participated) via the
 * webapp API (`GET /api/v1/conversations`).
 *
 * Spec: TOOL-HANDOFF.md §4.3
 *   - inputs: limit? (default 20), offset?, search?, archived?
 *   - output: { conversations: [...], total }
 *
 * The current webapp route does not implement server-side text search; the
 * `search` arg is sent through but the server may ignore it. We also emulate
 * client-side filtering when search is provided so agents get a useful result
 * even before the server supports it. `archived` maps to the route's
 * `includeArchived` query param.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ListConversationsArgs {
  limit?: number;
  offset?: number;
  search?: string;
  archived?: boolean;
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

const listConversationsTool: NativeToolDefinition = {
  description:
    'List conversations visible to the caller (owned and participated). Use to discover conversation IDs before reading messages or posting replies.',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: 'Max number of conversations to return (default 20).',
        minimum: 1,
        maximum: 200,
      },
      offset: {
        type: 'integer',
        description: 'Pagination offset (default 0).',
        minimum: 0,
      },
      search: {
        type: 'string',
        description:
          'Optional substring filter. Matched client-side against the conversation title (case-insensitive).',
      },
      archived: {
        type: 'boolean',
        description:
          'If true, include archived conversations in the result. Default false.',
      },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ListConversationsArgs>;

    const limit =
      args.limit !== undefined && Number.isFinite(Number(args.limit))
        ? Math.min(200, Math.max(1, Math.floor(Number(args.limit))))
        : 20;
    const offset =
      args.offset !== undefined && Number.isFinite(Number(args.offset))
        ? Math.max(0, Math.floor(Number(args.offset)))
        : 0;
    const search = typeof args.search === 'string' ? args.search.trim() : '';
    const archived = args.archived === true;

    const baseUrl = getBaseUrl();
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    if (archived) params.set('includeArchived', 'true');
    const url = `${baseUrl}/api/v1/conversations?${params.toString()}`;

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
                  `Conversations API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const rawList = Array.isArray(data?.conversations) ? data.conversations : [];
      const total = typeof data?.total === 'number' ? data.total : rawList.length;

      // Client-side text filter: the route does not implement search yet.
      // Filtering after the fetch keeps the result useful for agents while
      // staying forward-compatible with a server-side implementation.
      const filtered = search
        ? rawList.filter((c: AnyObject) =>
            String(c?.title ?? '').toLowerCase().includes(search.toLowerCase()),
          )
        : rawList;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              conversations: filtered,
              total: search ? filtered.length : total,
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

export default listConversationsTool;
module.exports = listConversationsTool;
