/**
 * Store Message — Native Context Tool
 *
 * Stores a message in conversation history via MemoryManager.
 * Persists to both Redis cache and MongoDB. Produces identical results
 * to the MCP context-sse.ts `store_message` handler.
 *
 * Ported from: src/lib/mcp/servers/context-sse.ts → store_message
 */

import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { MemoryManager, ConversationMessage } from '../../memory/memory';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface StoreMessageArgs {
  conversationId: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
  toolExecutions?: AnyObject[];
}

let _memoryManager: MemoryManager | null = null;

function getMemoryManager(): MemoryManager {
  if (!_memoryManager) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    _memoryManager = new MemoryManager(redisUrl);
  }
  return _memoryManager;
}

const storeMessage: NativeToolDefinition = {
  description:
    'Store a message in conversation history. Persists to both Redis cache and MongoDB.',
  server: 'context',

  inputSchema: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The conversation ID',
      },
      role: {
        type: 'string',
        enum: ['system', 'user', 'assistant'],
        description: 'Message role',
      },
      content: {
        type: 'string',
        description: 'Message content',
      },
      messageId: {
        type: 'string',
        description: 'Optional message ID (auto-generated if not provided)',
      },
      metadata: {
        type: 'object',
        description: 'Additional metadata',
        additionalProperties: true,
      },
      toolExecutions: {
        type: 'array',
        description: 'Array of tool execution data',
        items: { type: 'object' },
      },
    },
    required: ['conversationId', 'role', 'content'],
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = rawArgs as StoreMessageArgs;
    const {
      conversationId,
      role,
      content,
      messageId,
      toolExecutions,
    } = args;

    const publisher = context?.publisher || null;
    const nodeId = context?.nodeId || 'store_message';
    const startTime = Date.now();

    console.log(
      `[store_message] conversationId:${conversationId}, role:${role}, ` +
      `messageId:${messageId || '(auto)'}, content length:${content?.length}`
    );

    try {
      const mm = getMemoryManager();

      // Generate message ID if not provided
      const finalMessageId =
        messageId || `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      // Create message object
      const message: ConversationMessage = {
        id: finalMessageId,
        role,
        content,
        timestamp: Date.now(),
        toolExecutions: toolExecutions as any,
      };

      // Store via memory manager (handles both Redis and MongoDB)
      await mm.addMessage(conversationId, message);

      const duration = Date.now() - startTime;
      console.log(`[store_message] Stored in ${duration}ms — messageId:${finalMessageId}`);

      // Publish progress via RunPublisher if available
      if (publisher) {
        try {
          (publisher as AnyObject).publish({
            type: 'tool_output',
            nodeId,
            data: {
              chunk: `[store_message] Stored ${role} message in ${conversationId} (${duration}ms)\n`,
              stream: 'stdout',
            },
          });
        } catch (_) { /* ignore */ }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              conversationId,
              messageId: finalMessageId,
              timestamp: message.timestamp,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - startTime;
      console.error(`[store_message] Error: ${msg}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: msg, durationMs: duration }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default storeMessage;
module.exports = storeMessage;
