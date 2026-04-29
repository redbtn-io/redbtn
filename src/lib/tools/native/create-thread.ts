/**
 * Create Thread — Native Tool
 *
 * Creates (or returns the existing) thread conversation off a root message
 * in a parent conversation via the webapp API
 * (`POST /api/v1/conversations/:id/threads`). When `firstMessage` is
 * supplied, the tool also posts that message into the new thread via
 * `POST /api/v1/conversations/:threadId/messages`.
 *
 * Spec: TOOL-HANDOFF.md §4.3
 *   - inputs: conversationId (required), parentMessageId (required), firstMessage? (string)
 *   - output: { threadId }
 *
 * The route is idempotent — if a thread for that parent message already
 * exists, it returns the same threadConversationId without re-creating.
 * `firstMessage` is only posted on a fresh creation OR when explicitly
 * supplied; this keeps repeat calls from spamming duplicate intros.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface CreateThreadArgs {
  conversationId: string;
  parentMessageId: string;
  firstMessage?: string;
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

const createThreadTool: NativeToolDefinition = {
  description:
    'Branch a new thread off a parent message in a conversation. Idempotent: returns the existing thread id if one already exists. Optionally posts an opening message into the new thread.',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The parent conversation id this thread branches from.',
      },
      parentMessageId: {
        type: 'string',
        description: 'The id of the message in the parent conversation that anchors the thread.',
      },
      firstMessage: {
        type: 'string',
        description:
          'Optional opening message to post into the new thread immediately after creation.',
      },
    },
    required: ['conversationId', 'parentMessageId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<CreateThreadArgs>;
    const conversationId =
      typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
    const parentMessageId =
      typeof args.parentMessageId === 'string' ? args.parentMessageId.trim() : '';
    const firstMessage =
      typeof args.firstMessage === 'string' && args.firstMessage.trim().length > 0
        ? args.firstMessage.trim()
        : undefined;

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

    if (!parentMessageId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'parentMessageId is required and must be a non-empty string',
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
      // 1. Create (or find) the thread.
      const createUrl = `${baseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/threads`;
      const createResp = await fetch(createUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ parentMessageId }),
      });

      if (!createResp.ok) {
        let errBody = '';
        try {
          errBody = await createResp.text();
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  `Threads API ${createResp.status} ${createResp.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: createResp.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const createData = (await createResp.json()) as AnyObject;
      const threadId =
        typeof createData?.threadConversationId === 'string'
          ? createData.threadConversationId
          : '';

      if (!threadId) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Threads API did not return threadConversationId',
              }),
            },
          ],
          isError: true,
        };
      }

      // 2. Optionally post the opening message into the new thread. We
      // intentionally post even if the thread pre-existed when the caller
      // supplied a firstMessage — they're explicitly asking for the message.
      if (firstMessage) {
        const msgUrl = `${baseUrl}/api/v1/conversations/${encodeURIComponent(threadId)}/messages`;
        const msgResp = await fetch(msgUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: firstMessage }),
        });
        if (!msgResp.ok) {
          let errBody = '';
          try {
            errBody = await msgResp.text();
          } catch {
            /* ignore */
          }
          // Thread was created; surface a partial-success error so the caller
          // can still use the threadId.
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  threadId,
                  error:
                    `Thread created but firstMessage post failed: ` +
                    `${msgResp.status} ${msgResp.statusText}` +
                    (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                  status: msgResp.status,
                }),
              },
            ],
            isError: true,
          };
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ threadId }),
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

export default createThreadTool;
module.exports = createThreadTool;
