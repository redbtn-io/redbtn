/**
 * Get Context — Native Context Tool
 *
 * Builds formatted conversation context for LLM consumption.
 * Automatically manages token limits, includes summaries, and formats
 * messages. Produces identical results to the MCP context-sse.ts
 * `get_context_history` handler.
 *
 * Ported from: src/lib/mcp/servers/context-sse.ts → get_context_history
 */

import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { MemoryManager } from '../../memory/memory';
import { resolveCallerUserId, checkConversationAccess } from './_conversation-access';
import { isUsableConversationId } from '../../conversation/conversation-id';
import { errorTurnNote, formatInterruptedTurnNote } from '../../conversation/response-kind';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetContextArgs {
  conversationId: string;
  maxTokens?: number;
  includeSystemPrompt?: boolean;
  systemPromptText?: string;
  includeSummary?: boolean;
  summaryType?: 'trailing' | 'executive' | 'both';
  format?: 'raw' | 'formatted' | 'llm';
  /**
   * What to do with assistant turns stored with `metadata.kind` 'error' /
   * 'fallback' (fallback values, graph-declared error replies, failed runs):
   *   - 'omit' (default): leave them out, so the model never sees (and never
   *     learns to repeat) error text;
   *   - 'note': replace each with a short bracketed note, no verbatim text;
   *   - 'include': keep them verbatim (debugging / transcripts).
   */
  errorTurns?: 'omit' | 'note' | 'include';
  /** Shorthand for `errorTurns: 'include'`. */
  includeErrorTurns?: boolean;
}


let _memoryManager: MemoryManager | null = null;

function getMemoryManager(): MemoryManager {
  if (!_memoryManager) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    _memoryManager = new MemoryManager(redisUrl);
  }
  return _memoryManager;
}

const getContext: NativeToolDefinition = {
  description:
    'Build formatted conversation context for LLM consumption. Automatically manages token limits, includes summaries, and formats messages.',
  server: 'context',

  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation ID to build context for',
      },
      maxTokens: {
        type: 'number',
        description: 'Maximum tokens for recent messages (default: 30000)',
        default: 30000,
      },
      includeSystemPrompt: {
        type: 'boolean',
        description: 'Include system prompt in formatted output',
        default: false,
      },
      systemPromptText: {
        type: 'string',
        description: 'Custom system prompt to prepend',
      },
      includeSummary: {
        type: 'boolean',
        description: 'Include conversation summary if available',
        default: true,
      },
      summaryType: {
        type: 'string',
        enum: ['trailing', 'executive', 'both'],
        description:
          'Type of summary to include: trailing (old messages), executive (overview), or both',
        default: 'trailing',
      },
      format: {
        type: 'string',
        enum: ['raw', 'formatted', 'llm'],
        description: 'Output format: raw (objects), formatted (text), llm (ready for model)',
        default: 'llm',
      },
      errorTurns: {
        type: 'string',
        enum: ['omit', 'note', 'include'],
        description:
          'Assistant turns that were error or fallback messages rather than answers: omit them (default), ' +
          'replace each with a short note, or include them verbatim',
        default: 'omit',
      },
      includeErrorTurns: {
        type: 'boolean',
        description: 'Shorthand for errorTurns: "include"',
        default: false,
      },
    },
    required: ['conversationId'],
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = rawArgs as GetContextArgs;
    const {
      conversationId,
      includeSummary = true,
      summaryType = 'trailing',
      format = 'llm',
      includeSystemPrompt = false,
      systemPromptText,
    } = args;
    const errorTurns: 'omit' | 'note' | 'include' =
      args.includeErrorTurns === true || String(args.includeErrorTurns) === 'true'
        ? 'include'
        : args.errorTurns === 'note' || args.errorTurns === 'include'
          ? args.errorTurns
          : 'omit';

    const publisher = context?.publisher || null;
    const nodeId = context?.nodeId || 'get_context';
    const startTime = Date.now();

    // ── No-conversation fast path ─────────────────────────────────────
    // Automation/cron runs have no conversation: the system `context` node
    // renders `{{state.data.options.conversationId}}` to JS `undefined`.
    // Return a SUCCESSFUL empty context (not an error) so the node
    // continues normally, and never let the id reach a Redis key or a
    // Mongo filter. This MUST come before the access check: there is no
    // document to check access against, and refusing here would break
    // every conversation-less run.
    if (!isUsableConversationId(conversationId)) {
      console.log(
        `[get_context] No usable conversationId (${String(conversationId)}) — returning empty context`
      );
      if (format === 'raw') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  conversationId: null,
                  trailingSummary: null,
                  executiveSummary: null,
                  messages: [],
                  totalTokens: 0,
                  noConversation: true,
                },
                null,
                2
              ),
            },
          ],
        };
      }
      if (format === 'formatted') {
        return {
          content: [
            {
              type: 'text',
              text:
                '# Conversation Context: (none — run has no conversation)\n\n' +
                '## Recent Messages (0 messages, ~0 tokens)\n\n' +
                '(no conversation — automation/cron run)\n',
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                messages: [],
                metadata: {
                  conversationId: null,
                  messageCount: 0,
                  totalTokens: 0,
                  hasTrailingSummary: false,
                  hasExecutiveSummary: false,
                  noConversation: true,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    console.log(`[get_context] Building context for ${conversationId}, format=${format}`);

    // ── Access check ──────────────────────────────────────────────────
    // This tool reads directly from MemoryManager/user_conversations,
    // bypassing the webapp API's ownership check that get_messages relies
    // on. Without this, any caller supplying a guessed/known
    // conversationId could read another user's conversation history and
    // summaries.
    const callerUserId = resolveCallerUserId(context);
    if (!callerUserId) {
      return {
        content: [
          {
            type: 'text',
            text: 'No userId available in graph state — cannot perform access check',
          },
        ],
        isError: true,
      };
    }
    const access = await checkConversationAccess(conversationId, callerUserId);
    if (!access.ok) {
      return {
        content: [{ type: 'text', text: access.error || 'Forbidden' }],
        isError: true,
      };
    }

    try {
      const mm = getMemoryManager();

      // Fetch summary if requested
      let trailingSummary: string | null = null;
      let executiveSummary: string | null = null;

      if (includeSummary) {
        if (summaryType === 'trailing' || summaryType === 'both') {
          trailingSummary = await mm.getTrailingSummary(conversationId);
        }
        if (summaryType === 'executive' || summaryType === 'both') {
          executiveSummary = await mm.getExecutiveSummary(conversationId);
        }
      }

      // Fetch recent messages within token limit
      const loaded = await mm.getContextForConversation(conversationId, {
        includeErrorTurns: errorTurns !== 'omit',
      });
      const recentMessages = loaded.map((m) => {
        if (m.kind === 'interrupted') {
          return {
            ...m,
            content: formatInterruptedTurnNote(m),
            thinking: undefined,
          };
        }
        if (errorTurns === 'note' && m.kind) {
          return {
            ...m,
            content: errorTurnNote(m.kind),
            thinking: undefined,
            toolExecutions: [],
          };
        }
        return m;
      });

      // Who is in this conversation? Human turns carry a userId and agent
      // turns `agent:<id>`; without resolving those to names every format
      // below flattens a group into an anonymous "user" (the bug where the
      // assistant greeted two different people as "User").
      const senderNames = new Map<string, string>();
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mongoose = require('mongoose');
        const db = mongoose.connection?.readyState === 1 ? mongoose.connection.db : null;
        if (db) {
          const query = mongoose.Types.ObjectId.isValid(conversationId)
            ? { _id: new mongoose.Types.ObjectId(conversationId) }
            : { conversationId };
          const conv = await db.collection('user_conversations').findOne(query, {
            projection: { participants: 1, agents: 1 },
          });
          for (const p of conv?.participants ?? []) {
            const label = p?.displayName || p?.email;
            if (p?.userId && label) senderNames.set(String(p.userId), String(label));
          }
          for (const a of conv?.agents ?? []) {
            if (a?.id && a?.name) senderNames.set(`agent:${a.id}`, String(a.name));
          }
        }
      } catch (err) {
        console.warn('[get_context] sender-name lookup failed:', (err as Error).message);
      }
      const labelFor = (msg: { senderId?: string; role: string }): string | undefined => {
        if (!msg.senderId) return undefined;
        return senderNames.get(msg.senderId);
      };
      // Only disambiguate when there is actually something to disambiguate:
      // a 1:1 chat stays clean, a group gets names.
      const distinctHumanSenders = new Set(
        recentMessages.filter((m) => m.role === 'user' && m.senderId).map((m) => m.senderId as string),
      );
      const multiParty = distinctHumanSenders.size > 1;

      // Estimate total tokens (rough: 1 token ~ 4 chars)
      let totalTokens = 0;
      for (const msg of recentMessages) {
        totalTokens += Math.ceil((msg.role.length + msg.content.length) / 4) + 4;
      }

      const duration = Date.now() - startTime;
      console.log(
        `[get_context] Built context: ${recentMessages.length} messages, ~${totalTokens} tokens in ${duration}ms`
      );

      // Stream progress via RunPublisher
      if (publisher) {
        try {
          (publisher as AnyObject).publish({
            type: 'tool_output',
            nodeId,
            data: {
              chunk:
                `[get_context] ${recentMessages.length} messages, ~${totalTokens} tokens (${duration}ms)\n`,
              stream: 'stdout',
            },
          });
        } catch (_) { /* ignore */ }
      }

      // Format output based on requested format
      if (format === 'raw') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  conversationId,
                  trailingSummary,
                  executiveSummary,
                  messages: recentMessages.map((m) => ({
                    ...m,
                    senderName: labelFor(m),
                  })),
                  totalTokens,
                },
                null,
                2
              ),
            },
          ],
        };
      } else if (format === 'formatted') {
        let text = `# Conversation Context: ${conversationId}\n\n`;
        if (trailingSummary) {
          text += `## Previous Context Summary\n${trailingSummary}\n\n`;
        }
        if (executiveSummary) {
          text += `## Executive Summary\n${executiveSummary}\n\n`;
        }
        text += `## Recent Messages (${recentMessages.length} messages, ~${totalTokens} tokens)\n\n`;
        for (const msg of recentMessages) {
          const who = labelFor(msg) || msg.role.toUpperCase();
          text += `**${who}** (${new Date(msg.timestamp).toISOString()}):\n${msg.content}\n\n`;
        }
        return { content: [{ type: 'text', text }] };
      } else {
        // LLM format: ready to use in model input
        const llmMessages: AnyObject[] = [];

        if (includeSystemPrompt && systemPromptText) {
          llmMessages.push({ role: 'system', content: systemPromptText });
        }
        if (trailingSummary) {
          llmMessages.push({
            role: 'user',
            content: `[Previous conversation context: ${trailingSummary}]`,
          });
        }
        for (const msg of recentMessages) {
          const who = labelFor(msg);
          const content = multiParty && msg.role === 'user' && who
            ? `${who}: ${msg.content}`
            : msg.content;
          llmMessages.push({
            role: msg.role,
            content,
            ...(who ? { name: who } : {}),
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  messages: llmMessages,
                  metadata: {
                    conversationId,
                    messageCount: recentMessages.length,
                    totalTokens,
                    hasTrailingSummary: !!trailingSummary,
                    hasExecutiveSummary: !!executiveSummary,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - startTime;
      console.error(`[get_context] Error: ${msg}`);

      return {
        content: [
          {
            type: 'text',
            text: `Failed to build context history: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  },
};

export default getContext;
module.exports = getContext;
