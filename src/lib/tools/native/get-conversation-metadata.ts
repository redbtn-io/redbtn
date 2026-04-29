/**
 * Get Conversation Metadata — Native Tool
 *
 * Returns a compact metadata view of a conversation by reading the full doc
 * via the webapp API (`GET /api/v1/conversations/:id`) and projecting it
 * down to the fields the spec calls out:
 *   { id, title, graphId, createdAt, lastMessageAt, messageCount, participants }
 *
 * Spec: TOOL-HANDOFF.md §4.3 — replaces the old MCP `get_conversation_metadata`.
 *
 * `graphId` is optional on the conversation document and is sourced from the
 * graphInputs / config-overrides path when present; the route doesn't always
 * surface it, so we forward whatever the API gives us (typically null).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetConversationMetadataArgs {
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

const getConversationMetadataTool: NativeToolDefinition = {
  description:
    'Read a compact metadata view of a conversation: id, title, graphId, timestamps, message count, and participant list. Use when you only need a summary, not the full message history.',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation id whose metadata to fetch.',
      },
    },
    required: ['conversationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetConversationMetadataArgs>;
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
    const url = `${baseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}`;

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
                  `Conversation API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const conv = (data?.conversation as AnyObject) ?? {};

      // Project to the spec shape. `graphId` is not always present on the
      // returned doc; surface it when available, otherwise null.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              id: conv.id ?? conversationId,
              title: conv.title ?? null,
              graphId: conv.graphId ?? conv.graphInputs?.graphId ?? null,
              createdAt: conv.createdAt ?? null,
              lastMessageAt: conv.lastMessageAt ?? null,
              messageCount:
                typeof conv.messageCount === 'number' ? conv.messageCount : null,
              participants: Array.isArray(conv.participants) ? conv.participants : [],
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

export default getConversationMetadataTool;
module.exports = getConversationMetadataTool;
