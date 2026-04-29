/**
 * List Participants — Native Tool
 *
 * Lists all participants in a conversation via the webapp API
 * (`GET /api/v1/conversations/:id/participants`).
 *
 * Spec: TOOL-HANDOFF.md §4.3
 *   - inputs: conversationId (required)
 *   - output: { participants: [{ userId, role, addedAt }] }
 *
 * The webapp route returns richer participant rows (including displayName,
 * email, color); we project to the spec's three fields. `addedAt` maps to
 * the route's `joinedAt`. Owner rows are auto-synthesized server-side for
 * legacy single-user conversations, so the result is always populated even
 * for older conversations that pre-date the participants[] array.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ListParticipantsArgs {
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

const listParticipantsTool: NativeToolDefinition = {
  description:
    'List all participants in a conversation. Use to discover who is in the chat before mentioning, replying to, or removing someone.',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation id whose participants to list.',
      },
    },
    required: ['conversationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ListParticipantsArgs>;
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
    const url = `${baseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/participants`;

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
                  `Participants API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const raw = Array.isArray(data?.participants) ? data.participants : [];

      // Project to spec shape but keep the richer fields so callers that need
      // displayName / email / color don't have to re-fetch.
      const participants = raw.map((p: AnyObject) => ({
        userId: p?.userId ?? null,
        role: p?.role ?? null,
        addedAt: p?.joinedAt ?? null,
        displayName: p?.displayName ?? null,
        email: p?.email ?? null,
        color: p?.color ?? null,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ participants }),
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

export default listParticipantsTool;
module.exports = listParticipantsTool;
