/**
 * Create Conversation — Native Tool
 *
 * Creates a new conversation via the webapp API
 * (`POST /api/v1/conversations`).
 *
 * Spec: TOOL-HANDOFF.md §4.3
 *   - inputs: title? (string), graphId? (string), metadata? (object)
 *   - output: { conversationId, createdAt }
 *
 * Auth follows the standard Bearer / X-Internal-Key fallback used by other
 * conversation-pack tools.
 *
 * Note on `graphId` and `metadata`:
 *   The current webapp POST route only persists `title` and `graphInputs`.
 *   `graphId` is forwarded as a top-level field and `metadata` is forwarded
 *   verbatim — the route silently ignores fields it doesn't understand.
 *   Callers can rely on `title` taking effect today and treat the other two
 *   as a forward-compatible declaration.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface CreateConversationArgs {
  title?: string;
  graphId?: string;
  metadata?: Record<string, unknown>;
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

const createConversationTool: NativeToolDefinition = {
  description:
    'Create a new conversation. Use to spin up a fresh chat thread (optionally with a starting title or attached graph) before posting messages or running an agent.',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'Optional starting title for the conversation. Defaults to "New Conversation" server-side when omitted.',
      },
      graphId: {
        type: 'string',
        description:
          'Optional graphId this conversation should default to for agent runs. Currently advisory; agent dispatch still resolves the graph at chat-completion time.',
      },
      metadata: {
        type: 'object',
        description:
          'Optional metadata bag persisted with the conversation. Free-form JSON.',
      },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<CreateConversationArgs>;
    const title = typeof args.title === 'string' ? args.title : undefined;
    const graphId = typeof args.graphId === 'string' ? args.graphId : undefined;
    const metadata =
      args.metadata && typeof args.metadata === 'object' ? args.metadata : undefined;

    // Light validation — all fields optional, but if title is provided it must
    // be a non-empty string.
    if (args.title !== undefined && (typeof args.title !== 'string' || !title?.trim())) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'title, when provided, must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/conversations`;

    const body: AnyObject = {};
    if (title !== undefined) body.title = title;
    if (graphId !== undefined) body.graphId = graphId;
    if (metadata !== undefined) body.metadata = metadata;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
        body: JSON.stringify(body),
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
      const conv = data?.conversation || {};
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              conversationId: conv.id ?? null,
              createdAt: conv.createdAt ?? null,
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

export default createConversationTool;
module.exports = createConversationTool;
