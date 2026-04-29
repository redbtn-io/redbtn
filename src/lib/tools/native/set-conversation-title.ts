/**
 * Set Conversation Title — Native Tool
 *
 * Updates a conversation's title via the webapp API
 * (`PATCH /api/v1/conversations/:id`).
 *
 * Spec: TOOL-HANDOFF.md §4.3
 *   - inputs: conversationId (required), title (required)
 *   - output: { ok: true }
 *
 * The webapp PATCH route accepts `{ title }` (and other fields). Member+
 * access is required server-side; viewers will get back 403 which surfaces
 * here as `isError: true`.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface SetConversationTitleArgs {
  conversationId: string;
  title: string;
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

const setConversationTitleTool: NativeToolDefinition = {
  description:
    'Rename a conversation by setting its title. Use after the agent has identified a meaningful subject for the chat (e.g. auto-titling).',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation id to rename.',
      },
      title: {
        type: 'string',
        description: 'The new title. Must be a non-empty string.',
      },
    },
    required: ['conversationId', 'title'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<SetConversationTitleArgs>;
    const conversationId =
      typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
    const title = typeof args.title === 'string' ? args.title : '';

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

    if (!title.trim()) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'title is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}`;

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: buildHeaders(context),
        body: JSON.stringify({ title }),
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
                  `Conversation API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
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
            text: JSON.stringify({ ok: true }),
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

export default setConversationTitleTool;
module.exports = setConversationTitleTool;
