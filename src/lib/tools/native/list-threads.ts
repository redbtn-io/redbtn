/**
 * List Threads — Native Tool
 *
 * Lists thread conversations branching off a parent conversation via the
 * webapp API (`GET /api/v1/conversations/:id/threads`).
 *
 * Spec: TOOL-HANDOFF.md §4.3
 *   - inputs: conversationId (required)
 *   - output: { threads: [{ threadId, parentMessageId, replyCount, lastReplyAt }] }
 *
 * The webapp route returns each thread as a conversation summary; we project
 * to the spec shape:
 *   API `id`             → spec `threadId`
 *   API `parentMessageId` → spec `parentMessageId`
 *   API `replyCount`     → spec `replyCount`
 *   API `lastMessageAt`  → spec `lastReplyAt`
 *
 * Threads are conversations themselves with `isThread: true` plus
 * parentConversationId/parentMessageId backlinks. The route surfaces only
 * the bookkeeping fields needed to render a thread footer or pick a thread
 * to drill into.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ListThreadsArgs {
  conversationId: string;
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

const listThreadsTool: NativeToolDefinition = {
  description:
    'List thread conversations branching off a parent conversation. Use to discover sub-discussions before drilling into one.',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The parent conversation id whose threads to list.',
      },
    },
    required: ['conversationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ListThreadsArgs>;
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

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/threads`;

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
                  `Threads API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const raw = Array.isArray(data?.threads) ? data.threads : [];
      const threads = raw.map((t: AnyObject) => ({
        threadId: String(t?.id ?? ''),
        parentMessageId: t?.parentMessageId ?? null,
        replyCount: typeof t?.replyCount === 'number' ? t.replyCount : 0,
        lastReplyAt: t?.lastMessageAt ?? null,
        title: t?.title ?? null,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ threads }),
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

export default listThreadsTool;
module.exports = listThreadsTool;
