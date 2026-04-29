/**
 * Get Conversation Summary — Native Tool
 *
 * Reads the cached conversation summary (executive + trailing) via the
 * webapp API (`GET /api/v1/conversations/:id/summary`).
 *
 * Spec: TOOL-HANDOFF.md §4.3 — replaces the old MCP `get_conversation_summary`.
 *   - inputs: conversationId (required), regenerate? (default false)
 *   - output: { summary, generatedAt, fromCache: boolean }
 *
 * Note on `regenerate`:
 *   The webapp route accepts `?regenerate=true` for API parity but does NOT
 *   currently force a synchronous re-summarisation (LLM calls would block
 *   the request). When `regenerate: true` is supplied we forward it; the
 *   server will return whatever's cached and report `regenerated: false`.
 *   A follow-up can wire this through to a background job if needed.
 *
 * The tool's response surfaces the executive summary as the canonical
 * `summary`; trailing summary is exposed via the additional fields the
 * route returns and is preserved in the response body for callers that
 * want both.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetConversationSummaryArgs {
  conversationId: string;
  regenerate?: boolean;
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

const getConversationSummaryTool: NativeToolDefinition = {
  description:
    'Read the cached executive/trailing summary for a conversation. Use to ground a follow-up response in the conversation history without pulling the full message log.',
  server: 'conversation',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation id to summarise.',
      },
      regenerate: {
        type: 'boolean',
        description:
          'If true, request that the server regenerate the summary. Currently advisory — the server returns the cached summary and reports whether a regeneration happened in the response.',
      },
    },
    required: ['conversationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetConversationSummaryArgs>;
    const conversationId =
      typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
    const regenerate = args.regenerate === true;

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
    const params = new URLSearchParams();
    if (regenerate) params.set('regenerate', 'true');
    const qs = params.toString();
    const url =
      `${baseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/summary` +
      (qs ? `?${qs}` : '');

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
                  `Summary API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      // Spec output shape, plus passthrough of executive/trailing for callers
      // that want to distinguish them.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: data?.summary ?? null,
              executiveSummary: data?.executiveSummary ?? null,
              trailingSummary: data?.trailingSummary ?? null,
              generatedAt: data?.generatedAt ?? null,
              fromCache: data?.fromCache !== false,
              regenerated: data?.regenerated === true,
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

export default getConversationSummaryTool;
module.exports = getConversationSummaryTool;
