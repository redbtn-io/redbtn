/**
 * Delete Conversation — Native Tool
 *
 * Either soft-archives a conversation (default) or hard-deletes it via the
 * webapp API.
 *
 * Spec: TOOL-HANDOFF.md §4.3
 *   - inputs: conversationId (required), archive? (default true)
 *   - output: { ok: true, archived: boolean }
 *
 * Behaviour:
 *   archive=true (default) → PATCH /api/v1/conversations/:id { isArchived: true }
 *                            (member+ access required)
 *   archive=false          → DELETE /api/v1/conversations/:id
 *                            (owner-only)
 *
 * Soft-archive is the default because it's recoverable; agents that mean to
 * permanently destroy data must opt in explicitly.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface DeleteConversationArgs {
  conversationId: string;
  archive?: boolean;
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

const deleteConversationTool: NativeToolDefinition = {
  description:
    'Archive or permanently delete a conversation. Defaults to archive (recoverable). Pass archive=false to hard-delete.',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation id to archive or delete.',
      },
      archive: {
        type: 'boolean',
        description:
          'If true (default), soft-archive the conversation — it can be restored later. If false, permanently delete.',
      },
    },
    required: ['conversationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<DeleteConversationArgs>;
    const conversationId =
      typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
    // Default to archive=true if not explicitly false (covers undefined / true / non-boolean).
    const archive = args.archive !== false;

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
      const response = archive
        ? await fetch(url, {
            method: 'PATCH',
            headers: buildHeaders(context),
            body: JSON.stringify({ isArchived: true }),
          })
        : await fetch(url, {
            method: 'DELETE',
            headers: buildHeaders(context),
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
            text: JSON.stringify({ ok: true, archived: archive }),
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

export default deleteConversationTool;
module.exports = deleteConversationTool;
