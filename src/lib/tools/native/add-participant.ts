/**
 * Add Participant — Native Tool
 *
 * Invites a user to join a conversation via the webapp API
 * (`POST /api/v1/conversations/:id/participants`).
 *
 * Spec: TOOL-HANDOFF.md §4.3
 *   - inputs: conversationId (required), userId (required), role: 'member' | 'viewer' (required)
 *   - output: { ok: true }
 *
 * The webapp route accepts either `userId` (preferred for agent tools — no
 * email lookup) or `email`. We always send `userId`. Owner-only on the
 * server side; non-owners get a 403 surfaced as `isError: true`.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface AddParticipantArgs {
  conversationId: string;
  userId: string;
  role: 'member' | 'viewer';
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

const addParticipantTool: NativeToolDefinition = {
  description:
    'Add a participant (member or viewer) to a conversation by user id. Owner-only — the calling user must be the conversation owner. Use to grant another user access before broadcasting or sharing.',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation id to add the participant to.',
      },
      userId: {
        type: 'string',
        description: 'The id of the user to add.',
      },
      role: {
        type: 'string',
        enum: ['member', 'viewer'],
        description:
          "Participation role: 'member' can post and read, 'viewer' can only read.",
      },
    },
    required: ['conversationId', 'userId', 'role'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<AddParticipantArgs>;
    const conversationId =
      typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
    const userId = typeof args.userId === 'string' ? args.userId.trim() : '';
    const role = args.role;

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

    if (!userId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'userId is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    if (role !== 'member' && role !== 'viewer') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: "role is required and must be 'member' or 'viewer'",
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
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
        body: JSON.stringify({ userId, role }),
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
                  `Participants API ${response.status} ${response.statusText}` +
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

export default addParticipantTool;
module.exports = addParticipantTool;
