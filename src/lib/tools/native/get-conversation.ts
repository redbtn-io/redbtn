/**
 * Get Conversation — Native Tool
 *
 * Fetches a single conversation document via the webapp API
 * (`GET /api/v1/conversations/:id`).
 *
 * Spec: TOOL-HANDOFF.md §4.3
 *   - inputs: conversationId (required), includeMessages? (default false)
 *   - output: full conversation doc
 *
 * The webapp route always returns messages embedded in the response. When
 * `includeMessages: false` the tool strips the messages array out before
 * returning, matching the spec's intent (smaller payload for callers that
 * just need title / metadata / participants).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetConversationArgs {
  conversationId: string;
  includeMessages?: boolean;
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

const getConversationTool: NativeToolDefinition = {
  description:
    'Fetch a conversation document by id. Use to inspect title, participants, and metadata. Pass includeMessages=true to also receive the full message history.',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation id to fetch.',
      },
      includeMessages: {
        type: 'boolean',
        description:
          'If true, include the full messages array in the response. Default false (returns metadata only).',
      },
    },
    required: ['conversationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetConversationArgs>;
    const conversationId =
      typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
    const includeMessages = args.includeMessages === true;

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
      const conversation = (data?.conversation as AnyObject) ?? {};

      // Strip messages when caller didn't ask for them — keep payload small.
      if (!includeMessages) {
        delete conversation.messages;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ conversation }),
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

export default getConversationTool;
module.exports = getConversationTool;
