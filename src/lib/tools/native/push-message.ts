/**
 * push_message -- native tool for sending messages to conversations
 *
 * Pushes a message to a conversation stream in real-time.
 * The message appears immediately in the chat UI and is persisted to MongoDB.
 *
 * Can target the current run's conversation (default) or any conversation by ID.
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';

const definition: NativeToolDefinition = {
  description: 'Push a message to a conversation. Appears instantly in the chat UI and is saved to the database. Can target any conversation by ID.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Message content to send',
      },
      conversationId: {
        type: 'string',
        description: 'Target conversation ID. Defaults to the current run\'s conversation.',
      },
      role: {
        type: 'string',
        enum: ['assistant', 'system'],
        description: 'Message role (default: assistant)',
      },
    },
    required: ['content'],
  },

  async handler(args: Record<string, unknown>, context: NativeToolContext): Promise<NativeMcpResult> {
    const content = (args.content as string || '').trim();
    if (!content) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Content is required' }) }],
        isError: true,
      };
    }

    const role = (args.role as string) || 'assistant';

    // Determine target conversation
    const conversationId = (args.conversationId as string)
      || (context.state?.data?.conversationId as string | undefined)
      || (context.state?.options?.conversationId as string | undefined)
      || (context.state?.conversationId as string | undefined);

    if (!conversationId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'No conversationId available. Pass it explicitly or run within a conversation context.' }) }],
        isError: true,
      };
    }

    const { publisher } = context;
    publisher?.emit?.('log', `push_message to ${conversationId}: ${content.substring(0, 50)}...`);

    // Collect metadata: include runId + agentId so the chat UI can attribute
    // push_message bubbles to the correct agent (same avatar / label as the
    // run's final response).
    const agentId = (context.state?.options as Record<string, unknown> | undefined)?.agentId as string | undefined;
    const metadata: Record<string, unknown> = {
      source: 'push_message_tool',
      runId: context.runId ?? context.state?.runId,
      ...(agentId ? { agentId } : {}),
    };

    // Preferred path: use the RunPublisher's existing ConversationPublisher so
    // the message is published on the SAME Redis connection as run_complete.
    // This guarantees ordering — the message arrives at the client BEFORE the
    // run_complete event, not after it.
    const runPublisher = publisher as (typeof publisher & { pushConversationMessage?: (p: Record<string, unknown>) => Promise<string | null> }) | null;
    if (runPublisher?.pushConversationMessage) {
      try {
        const messageId = await runPublisher.pushConversationMessage({
          content,
          role: role as 'assistant' | 'system',
          metadata,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, messageId, conversationId }) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        publisher?.emit?.('log', `push_message via RunPublisher failed, falling back: ${msg}`);
        // Fall through to the IORedis fallback path below
      }
    }

    // Fallback: create a short-lived Redis connection (original behaviour).
    // Used when push_message is called outside a full run context.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const IORedis = require('ioredis');
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      const redis = new IORedis(redisUrl);

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { createConversationPublisher } = require('../../conversation/index');
        const convPublisher = createConversationPublisher({ redis, conversationId });

        const messageId = await convPublisher.pushMessage({
          role: role as 'assistant' | 'system',
          content,
          metadata,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, messageId, conversationId }) }],
        };
      } finally {
        await redis.quit().catch(() => { /* ignore */ });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      publisher?.emit?.('log', `push_message failed: ${msg}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Failed to push message: ${msg}` }) }],
        isError: true,
      };
    }
  },
};

export = definition;
