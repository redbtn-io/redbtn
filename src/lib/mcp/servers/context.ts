/**
 * Context MCP Server
 * Manages conversation context, history, and message storage
 */

import { Redis } from 'ioredis';
import { McpServer } from '../server';
import { CallToolResult } from '../types';
import { McpEventPublisher } from '../event-publisher';
import { MemoryManager, ConversationMessage } from '../../memory/memory';
import { getDatabase, StoredToolExecution } from '../../memory/database';
import { countTokens } from '../../utils/tokenizer';

export class ContextServer extends McpServer {
  private memoryManager: MemoryManager;
  
  constructor(redis: Redis, redisUrl?: string) {
    super(redis, 'context', '1.0.0');
    this.memoryManager = new MemoryManager(redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');
    console.log('[Context Server] Initialized with Redis memory manager');
  }

  /**
   * Setup tools
   */
  protected async setup(): Promise<void> {
    // Define get_messages tool
    this.defineTool({
      name: 'get_messages',
      description: 'Fetch messages from a conversation. Returns messages with full metadata including tool executions. Use this to retrieve conversation history.',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: {
            type: 'string',
            description: 'The conversation ID to fetch messages from'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of messages to return (default: 100, 0 = all)',
            default: 100
          },
          source: {
            type: 'string',
            enum: ['cache', 'database', 'auto'],
            description: 'Source to fetch from: cache (Redis), database (MongoDB), or auto (tries cache first)',
            default: 'auto'
          },
          includeToolExecutions: {
            type: 'boolean',
            description: 'Include tool execution details in messages',
            default: true
          },
          startTime: {
            type: 'number',
            description: 'Filter messages after this timestamp (Unix milliseconds)'
          },
          endTime: {
            type: 'number',
            description: 'Filter messages before this timestamp (Unix milliseconds)'
          }
        },
        required: ['conversationId']
      }
    });

    // Define get_context_history tool
    this.defineTool({
      name: 'get_context_history',
      description: 'Build formatted conversation context for LLM consumption. Automatically manages token limits, includes summaries, and formats messages. Use this to prepare context for AI responses.',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: {
            type: 'string',
            description: 'The conversation ID to build context for'
          },
          maxTokens: {
            type: 'number',
            description: 'Maximum tokens for recent messages (default: 30000)',
            default: 30000
          },
          includeSummary: {
            type: 'boolean',
            description: 'Include conversation summary if available',
            default: true
          },
          summaryType: {
            type: 'string',
            enum: ['trailing', 'executive', 'both'],
            description: 'Type of summary to include: trailing (old messages), executive (overview), or both',
            default: 'trailing'
          },
          format: {
            type: 'string',
            enum: ['raw', 'formatted', 'llm'],
            description: 'Output format: raw (objects), formatted (text), llm (ready for model)',
            default: 'llm'
          },
          includeSystemPrompt: {
            type: 'boolean',
            description: 'Include system prompt in formatted output',
            default: false
          },
          systemPromptText: {
            type: 'string',
            description: 'Custom system prompt to prepend'
          }
        },
        required: ['conversationId']
      }
    });

    // Define get_summary tool
    this.defineTool({
      name: 'get_summary',
      description: 'Fetch conversation summary. Trailing summary contains context from old trimmed messages. Executive summary contains full conversation overview.',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: {
            type: 'string',
            description: 'The conversation ID'
          },
          summaryType: {
            type: 'string',
            enum: ['trailing', 'executive', 'both'],
            description: 'Type of summary to fetch',
            default: 'trailing'
          }
        },
        required: ['conversationId']
      }
    });

    // Define store_message tool
    this.defineTool({
      name: 'store_message',
      description: 'Store a new message in the conversation. Persists to both Redis cache and MongoDB. Use this to save user messages, assistant responses, or system messages.',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: {
            type: 'string',
            description: 'The conversation ID'
          },
          role: {
            type: 'string',
            enum: ['system', 'user', 'assistant'],
            description: 'Message role'
          },
          content: {
            type: 'string',
            description: 'Message content'
          },
          messageId: {
            type: 'string',
            description: 'Optional message ID (auto-generated if not provided)'
          },
          toolExecutions: {
            type: 'array',
            description: 'Array of tool execution data',
            items: {
              type: 'object'
            }
          },
          metadata: {
            type: 'object',
            description: 'Additional metadata',
            additionalProperties: true
          }
        },
        required: ['conversationId', 'role', 'content']
      }
    });

    // Define get_conversation_metadata tool
    this.defineTool({
      name: 'get_conversation_metadata',
      description: 'Get conversation metadata including message count, token count, summary status, and last updated time.',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: {
            type: 'string',
            description: 'The conversation ID'
          },
          includeTokenCount: {
            type: 'boolean',
            description: 'Calculate current token count (may be slow for large conversations)',
            default: false
          }
        },
        required: ['conversationId']
      }
    });

    // Define get_token_count tool
    this.defineTool({
      name: 'get_token_count',
      description: 'Calculate token count for messages or text. Use this to check if content fits within token limits.',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: {
            type: 'string',
            description: 'Calculate tokens for this conversation'
          },
          text: {
            type: 'string',
            description: 'Calculate tokens for this text'
          },
          messages: {
            type: 'array',
            description: 'Calculate tokens for these messages',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                content: { type: 'string' }
              }
            }
          }
        }
      }
    });

    // Define list_conversations tool
    this.defineTool({
      name: 'list_conversations',
      description: 'List recent conversations with metadata. Returns conversations sorted by most recent activity.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of conversations to return',
            default: 50
          },
          skip: {
            type: 'number',
            description: 'Number of conversations to skip (for pagination)',
            default: 0
          }
        }
      }
    });
  }

  /**
   * Execute tool - implementation of abstract method
   */
  protected async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    switch (toolName) {
      case 'get_messages':
        return this.getMessages(args, meta);
      case 'get_context_history':
        return this.getContextHistory(args, meta);
      case 'get_summary':
        return this.getSummary(args, meta);
      case 'store_message':
        return this.storeMessage(args, meta);
      case 'get_conversation_metadata':
        return this.getConversationMetadata(args, meta);
      case 'get_token_count':
        return this.getTokenCount(args, meta);
      case 'list_conversations':
        return this.listConversations(args, meta);
      default:
        return {
          content: [{
            type: 'text',
            text: `Unknown tool: ${toolName}`
          }],
          isError: true
        };
    }
  }

  /**
   * Get messages from conversation
   */
  private async getMessages(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const conversationId = args.conversationId as string;
    const limit = (args.limit as number) || 100;
    const source = (args.source as string) || 'auto';
    const includeToolExecutions = args.includeToolExecutions !== false;
    const startTime = args.startTime as number | undefined;
    const endTime = args.endTime as number | undefined;

    const publisher = new McpEventPublisher(this.publishRedis, 'context_get_messages', 'Get Messages', meta);

    await publisher.publishStart({ input: { conversationId, limit, source } });
    await publisher.publishLog('info', `📨 Fetching messages from ${conversationId}`);

    try {
      let messages: ConversationMessage[];

      // Fetch based on source
      if (source === 'database') {
        await publisher.publishProgress('Fetching from MongoDB...', { progress: 30 });
        messages = await this.memoryManager.getAllMessagesFromDB(conversationId);
      } else if (source === 'cache') {
        await publisher.publishProgress('Fetching from Redis cache...', { progress: 30 });
        messages = await this.memoryManager.getMessages(conversationId);
      } else {
        // Auto: try cache first, fall back to database
        await publisher.publishProgress('Fetching from cache...', { progress: 20 });
        messages = await this.memoryManager.getMessages(conversationId);
        
        if (messages.length === 0) {
          await publisher.publishProgress('Cache empty, fetching from database...', { progress: 50 });
          messages = await this.memoryManager.getAllMessagesFromDB(conversationId);
        }
      }

      // Apply time filters if provided
      if (startTime || endTime) {
        messages = messages.filter(msg => {
          if (startTime && msg.timestamp < startTime) return false;
          if (endTime && msg.timestamp > endTime) return false;
          return true;
        });
      }

      // Apply limit
      if (limit > 0 && messages.length > limit) {
        messages = messages.slice(-limit); // Get most recent N messages
      }

      // Filter tool executions if requested
      if (!includeToolExecutions) {
        messages = messages.map(msg => ({
          ...msg,
          toolExecutions: undefined
        }));
      }

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Fetched ${messages.length} messages in ${duration}ms`);
      await publisher.publishComplete({ messageCount: messages.length, duration });

      // Format output
      const result = {
        conversationId,
        messageCount: messages.length,
        messages: messages.map(msg => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          toolExecutions: msg.toolExecutions
        }))
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Failed to fetch messages: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Failed to fetch messages: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * Get context history formatted for LLM
   */
  private async getContextHistory(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const conversationId = args.conversationId as string;
    const maxTokens = (args.maxTokens as number) || 30000;
    const includeSummary = args.includeSummary !== false;
    const summaryType = (args.summaryType as string) || 'trailing';
    const format = (args.format as string) || 'llm';
    const includeSystemPrompt = args.includeSystemPrompt === true;
    const systemPromptText = args.systemPromptText as string | undefined;

    const publisher = new McpEventPublisher(this.publishRedis, 'context_get_history', 'Get Context History', meta);

    await publisher.publishStart({ input: { conversationId, maxTokens, format } });
    await publisher.publishLog('info', `📚 Building context history for ${conversationId}`);

    try {
      // Fetch summary if requested
      await publisher.publishProgress('Fetching summary...', { progress: 20 });
      let trailingSummary = null;
      let executiveSummary = null;

      if (includeSummary) {
        if (summaryType === 'trailing' || summaryType === 'both') {
          trailingSummary = await this.memoryManager.getTrailingSummary(conversationId);
        }
        if (summaryType === 'executive' || summaryType === 'both') {
          executiveSummary = await this.memoryManager.getExecutiveSummary(conversationId);
        }
      }

      // Fetch recent messages within token limit
      await publisher.publishProgress('Fetching recent messages...', { progress: 40 });
      const recentMessages = await this.memoryManager.getContextForConversation(conversationId);

      // Calculate token counts
      await publisher.publishProgress('Calculating token counts...', { progress: 60 });
      let totalTokens = 0;
      for (const msg of recentMessages) {
        totalTokens += await this.countMessageTokens(msg);
      }

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Built context: ${recentMessages.length} messages, ${totalTokens} tokens in ${duration}ms`);
      await publisher.publishComplete({
        messageCount: recentMessages.length,
        totalTokens,
        hasSummary: !!(trailingSummary || executiveSummary),
        duration
      });

      // Format output based on requested format
      if (format === 'raw') {
        // Raw format: return objects
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              conversationId,
              trailingSummary,
              executiveSummary,
              messages: recentMessages,
              totalTokens
            }, null, 2)
          }]
        };
      } else if (format === 'formatted') {
        // Formatted text
        let text = `# Conversation Context: ${conversationId}\n\n`;
        
        if (trailingSummary) {
          text += `## Previous Context Summary\n${trailingSummary}\n\n`;
        }
        if (executiveSummary) {
          text += `## Executive Summary\n${executiveSummary}\n\n`;
        }
        
        text += `## Recent Messages (${recentMessages.length} messages, ${totalTokens} tokens)\n\n`;
        for (const msg of recentMessages) {
          text += `**${msg.role.toUpperCase()}** (${new Date(msg.timestamp).toISOString()}):\n${msg.content}\n\n`;
        }

        return {
          content: [{
            type: 'text',
            text
          }]
        };
      } else {
        // LLM format: ready to use in model input
        const llmMessages: any[] = [];

        // Add system prompt if requested
        if (includeSystemPrompt && systemPromptText) {
          llmMessages.push({
            role: 'system',
            content: systemPromptText
          });
        }

        // Add summary as context if available
        if (trailingSummary) {
          llmMessages.push({
            role: 'user',
            content: `[Previous conversation context: ${trailingSummary}]`
          });
        }

        // Add recent messages
        for (const msg of recentMessages) {
          llmMessages.push({
            role: msg.role,
            content: msg.content
          });
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              messages: llmMessages,
              metadata: {
                conversationId,
                messageCount: recentMessages.length,
                totalTokens,
                hasTrailingSummary: !!trailingSummary,
                hasExecutiveSummary: !!executiveSummary
              }
            }, null, 2)
          }]
        };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Failed to build context: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Failed to build context history: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * Get conversation summary
   */
  private async getSummary(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const conversationId = args.conversationId as string;
    const summaryType = (args.summaryType as string) || 'trailing';

    const publisher = new McpEventPublisher(this.publishRedis, 'context_get_summary', 'Get Summary', meta);

    await publisher.publishStart({ input: { conversationId, summaryType } });
    await publisher.publishLog('info', `📄 Fetching ${summaryType} summary for ${conversationId}`);

    try {
      let trailingSummary = null;
      let executiveSummary = null;

      if (summaryType === 'trailing' || summaryType === 'both') {
        trailingSummary = await this.memoryManager.getTrailingSummary(conversationId);
      }
      if (summaryType === 'executive' || summaryType === 'both') {
        executiveSummary = await this.memoryManager.getExecutiveSummary(conversationId);
      }

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Retrieved summary in ${duration}ms`);
      await publisher.publishComplete({ duration });

      let result: any = { conversationId };

      if (summaryType === 'both') {
        result.trailingSummary = trailingSummary;
        result.executiveSummary = executiveSummary;
      } else if (summaryType === 'trailing') {
        result.summary = trailingSummary;
      } else {
        result.summary = executiveSummary;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Failed to get summary: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Failed to get summary: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * Store a new message
   */
  private async storeMessage(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const conversationId = args.conversationId as string;
    const role = args.role as 'system' | 'user' | 'assistant';
    const content = args.content as string;
    const messageId = args.messageId as string | undefined;
    const toolExecutions = args.toolExecutions as StoredToolExecution[] | undefined;
    const metadata = args.metadata as Record<string, any> | undefined;

    const publisher = new McpEventPublisher(this.publishRedis, 'context_store_message', 'Store Message', meta);

    await publisher.publishStart({ input: { conversationId, role } });
    console.log(`[Context MCP] storeMessage called - conversationId:${conversationId}, role:${role}, messageId:${messageId}, content length:${content?.length}`);
    console.log(`[Context MCP] toolExecutions received:`, toolExecutions ? toolExecutions.length : 'undefined', toolExecutions ? JSON.stringify(toolExecutions).substring(0, 200) : '');
    await publisher.publishLog('info', `💾 Storing ${role} message in ${conversationId}`);

    try {
      // Generate message ID if not provided
      const finalMessageId = messageId || `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      // Create message object
      const message: ConversationMessage = {
        id: finalMessageId,
        role,
        content,
        timestamp: Date.now(),
        toolExecutions
      };

      console.log(`[Context MCP] About to call addMessage - messageId:${finalMessageId}, role:${role}`);
      // Store via memory manager (handles both Redis and MongoDB)
      await this.memoryManager.addMessage(conversationId, message);
      console.log(`[Context MCP] addMessage completed - messageId:${finalMessageId}`);

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Message stored in ${duration}ms`);
      await publisher.publishComplete({ messageId: finalMessageId, duration });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            conversationId,
            messageId: finalMessageId,
            timestamp: message.timestamp
          }, null, 2)
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Failed to store message: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Failed to store message: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * Get conversation metadata
   */
  private async getConversationMetadata(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const conversationId = args.conversationId as string;
    const includeTokenCount = args.includeTokenCount === true;

    const publisher = new McpEventPublisher(this.publishRedis, 'context_get_metadata', 'Get Metadata', meta);

    await publisher.publishStart({ input: { conversationId } });
    await publisher.publishLog('info', `ℹ️ Fetching metadata for ${conversationId}`);

    try {
      // Get metadata from Redis
      const metadata = await this.memoryManager.getMetadata(conversationId);

      if (!metadata) {
        throw new Error(`Conversation ${conversationId} not found`);
      }

      // Optionally calculate current token count
      if (includeTokenCount) {
        await publisher.publishProgress('Calculating token count...', { progress: 50 });
        metadata.totalTokens = await this.memoryManager.getTokenCount(conversationId);
      }

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Retrieved metadata in ${duration}ms`);
      await publisher.publishComplete({ duration });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(metadata, null, 2)
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Failed to get metadata: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Failed to get metadata: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * Get token count
   */
  private async getTokenCount(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const conversationId = args.conversationId as string | undefined;
    const text = args.text as string | undefined;
    const messages = args.messages as Array<{ role: string; content: string }> | undefined;

    const publisher = new McpEventPublisher(this.publishRedis, 'context_get_tokens', 'Get Token Count', meta);

    await publisher.publishStart({ input: { hasConversationId: !!conversationId, hasText: !!text, hasMessages: !!messages } });
    await publisher.publishLog('info', '🔢 Calculating token count');

    try {
      let tokenCount = 0;

      if (conversationId) {
        // Count tokens for entire conversation
        tokenCount = await this.memoryManager.getTokenCount(conversationId);
      } else if (text) {
        // Count tokens for text
        tokenCount = await countTokens(text);
      } else if (messages) {
        // Count tokens for messages array
        for (const msg of messages) {
          const roleTokens = await countTokens(msg.role);
          const contentTokens = await countTokens(msg.content);
          tokenCount += roleTokens + contentTokens + 4; // 4 tokens overhead per message
        }
      } else {
        throw new Error('Must provide conversationId, text, or messages');
      }

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Token count: ${tokenCount} in ${duration}ms`);
      await publisher.publishComplete({ tokenCount, duration });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ tokenCount }, null, 2)
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Failed to count tokens: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Failed to count tokens: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * List conversations
   */
  private async listConversations(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const limit = (args.limit as number) || 50;
    const skip = (args.skip as number) || 0;

    const publisher = new McpEventPublisher(this.publishRedis, 'context_list_conversations', 'List Conversations', meta);

    await publisher.publishStart({ input: { limit, skip } });
    await publisher.publishLog('info', `📋 Listing conversations (limit: ${limit}, skip: ${skip})`);

    try {
      // Fetch from MongoDB
      const db = getDatabase();
      const conversations = await db.getConversations(limit, skip);

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Found ${conversations.length} conversations in ${duration}ms`);
      await publisher.publishComplete({ count: conversations.length, duration });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            conversations: conversations.map(conv => ({
              conversationId: conv.conversationId,
              title: conv.title,
              messageCount: conv.metadata?.messageCount,
              createdAt: conv.createdAt,
              updatedAt: conv.updatedAt
            })),
            count: conversations.length,
            limit,
            skip
          }, null, 2)
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Failed to list conversations: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Failed to list conversations: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * Helper: Count tokens in a message
   */
  private async countMessageTokens(message: ConversationMessage): Promise<number> {
    try {
      const roleTokens = await countTokens(message.role);
      const contentTokens = await countTokens(message.content);
      return roleTokens + contentTokens + 4; // 4 tokens overhead
    } catch (error) {
      // Fallback estimate
      return Math.ceil((message.role.length + message.content.length) / 4);
    }
  }
}
