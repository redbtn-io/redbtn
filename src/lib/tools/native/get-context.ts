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

    const publisher = context?.publisher || null;
    const nodeId = context?.nodeId || 'get_context';
    const startTime = Date.now();

    console.log(`[get_context] Building context for ${conversationId}, format=${format}`);

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
      const recentMessages = await mm.getContextForConversation(conversationId);

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
                  messages: recentMessages,
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
          text += `**${msg.role.toUpperCase()}** (${new Date(msg.timestamp).toISOString()}):\n${msg.content}\n\n`;
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
          llmMessages.push({ role: msg.role, content: msg.content });
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
