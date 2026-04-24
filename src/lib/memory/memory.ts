/**
 * @file src/lib/memory.ts
 * @description Conversation memory management with MongoDB persistence and Redis caching.
 *
 * Canonical storage:
 *   MongoDB collection `user_conversations`, document shape:
 *     { _id, userId, messages: [{ id, role, content, thinking?, toolExecutions?,
 *                                  metadata?, timestamp }], lastMessageAt, updatedAt, ... }
 *
 *   The conversationId flowing through this class is a string that is
 *   usually the ObjectId of the user_conversations document (from the
 *   webapp). We match it as `_id` when it's a valid ObjectId, otherwise
 *   we fall back to a (schema-less) `conversationId` field lookup --
 *   if neither matches we silently no-op.
 *
 *   Redis holds a hot cache of the last 100 messages plus
 *   summary/metadata state; it is never authoritative.
 */

import Redis from 'ioredis';
import { countTokens, freeTiktoken } from '../utils/tokenizer';
import { StoredToolExecution } from './database';

export interface ConversationMessage {
  id?: string; // Optional message ID (e.g., msg_1234567890_abc123def)
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
  thinking?: string; // Optional thinking/reasoning text
  toolExecutions?: StoredToolExecution[]; // Tool executions for this message
}

export interface ConversationMetadata {
  conversationId: string;
  messageCount: number;
  lastUpdated: number;
  summaryGenerated: boolean;
  totalTokens?: number; // Total tokens in conversation
  title?: string; // Generated or user-set title
  titleSetByUser?: boolean; // Whether title was manually set by user
}

export class MemoryManager {
  private redis: Redis;
  public readonly redisUrl: string;
  private readonly MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || '30000');
  private readonly SUMMARY_CUSHION_TOKENS = parseInt(process.env.SUMMARY_CUSHION_TOKENS || '2000');
  private readonly REDIS_MESSAGE_LIMIT = 100; // Keep last 100 messages in Redis for hot context
  private readonly MESSAGE_ID_INDEX_TTL = parseInt(process.env.CONVERSATION_MESSAGE_ID_TTL || (60 * 60 * 24 * 30).toString());

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
    this.redis = new Redis(redisUrl);
  }

  /**
   * Build a MongoDB filter to match the conversation document in
   * `user_conversations`. If `conversationId` is a valid ObjectId, match
   * `_id`; otherwise fall back to a schema-less `conversationId` field
   * (which doesn't exist on the canonical schema and thus will not match --
   * that's intentional, we fail quietly for legacy string ids).
   */
  private buildConversationFilter(conversationId: string): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mongoose = require('mongoose');
    const { ObjectId } = mongoose.Types;
    return ObjectId.isValid(conversationId)
      ? { _id: new ObjectId(conversationId) }
      : { conversationId };
  }

  /**
   * Get the mongoose-managed native MongoDB db handle, or null if mongoose
   * is not connected. All Memory persistence flows through mongoose so we
   * stay wired to the same connection the rest of the engine uses.
   */
  private getMongoDb(): any | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1) return null;
      return mongoose.connection.db || null;
    } catch {
      return null;
    }
  }

  /**
   * Generate a conversation ID based on initial message content (stable hashing)
   * or create a random ID if no seed is provided
   */
  generateConversationId(seedMessage?: string): string {
    if (seedMessage) {
      // Create stable ID based on message content
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(seedMessage).digest('hex').substring(0, 16);
      return `conv_${hash}`;
    }
    // Generate random ID for one-off conversations
    const crypto = require('crypto');
    return `conv_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Count tokens in a message
   */
  private async countMessageTokens(message: ConversationMessage): Promise<number> {
    try {
      // Format: role + content + overhead (4 tokens per message for formatting)
      const roleTokens = await countTokens(message.role);
      const contentTokens = await countTokens(message.content);
      return roleTokens + contentTokens + 4;
    } catch (error) {
      // Fallback: rough estimate (1 token ≈ 4 characters)
      return Math.ceil((message.role.length + message.content.length) / 4);
    }
  }

  /**
   * Count tokens in multiple messages
   */
  private async countMessagesTokens(messages: ConversationMessage[]): Promise<number> {
    let total = 0;
    for (const msg of messages) {
      total += await this.countMessageTokens(msg);
    }
    return total;
  }

  /**
   * Get conversation context: returns messages that fit within token limit.
   * Use getContextSummary() separately to retrieve summary for merging with system prompts.
   */
  async getContextForConversation(conversationId: string): Promise<ConversationMessage[]> {
    const messages = await this.getMessages(conversationId);
    
    // Calculate tokens and return messages that fit within limit
    let totalTokens = 0;
    const recentMessages: ConversationMessage[] = [];
    
    // Work backwards from most recent message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = await this.countMessageTokens(messages[i]);
      
      if (totalTokens + msgTokens <= this.MAX_CONTEXT_TOKENS) {
        recentMessages.unshift(messages[i]);
        totalTokens += msgTokens;
      } else {
        break;
      }
    }
    
    return recentMessages;
  }

  /**
   * Get conversation summary (if exists) for manual inclusion in system prompts.
   * Returns null if no summary has been generated yet.
   * This returns the TRAILING summary (old trimmed messages).
   */
  async getContextSummary(conversationId: string): Promise<string | null> {
    return await this.getTrailingSummary(conversationId);
  }

  /**
   * Add a new message to the conversation
   * Stores in both MongoDB (persistence) and Redis (hot cache of last 100 messages)
   */
  async addMessage(conversationId: string, message: ConversationMessage): Promise<void> {
    const key = `conversations:${conversationId}:messages`;
    const idIndexKey = `${key}:ids`;

    // Ensure message has an ID before we attempt to index it
    if (!message.id) {
      message.id = `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    }

    // Atomic duplicate guard – only the first writer wins
    let addedToIndex = 1;
    try {
      addedToIndex = await this.redis.sadd(idIndexKey, message.id);
      await this.redis.expire(idIndexKey, this.MESSAGE_ID_INDEX_TTL);
    } catch (error) {
      console.warn('[Memory] Failed to update message id index:', error instanceof Error ? error.message : String(error));
    }

    if (addedToIndex === 0) {
      console.log(`[Memory] Message ${message.id} already indexed for ${conversationId}, skipping duplicate`);
      return;
    }

    // Secondary guard in case the ID index was flushed but the list already contains the message
    const existingMessages = await this.redis.lrange(key, 0, -1);
    const alreadyInList = existingMessages.some((msgJson: string) => {
      try {
        const existingMsg = JSON.parse(msgJson);
        return existingMsg.id === message.id;
      } catch {
        return false;
      }
    });

    if (alreadyInList) {
      console.log(`[Memory] Message ${message.id} already exists in Redis cache for ${conversationId}, skipping duplicate`);
      return;
    }

    try {
      // Store in MongoDB for persistence — atomic upsert into
      // user_conversations.messages[]. The `'messages.id': { $ne: id }`
      // filter makes concurrent writers with the same messageId safe:
      // only the first push lands, subsequent ones are silent no-ops.
      const db = this.getMongoDb();
      if (db) {
        const filter = this.buildConversationFilter(conversationId);
        try {
          await db.collection('user_conversations').updateOne(
            { ...filter, 'messages.id': { $ne: message.id } },
            {
              $push: {
                messages: {
                  id: message.id,
                  role: message.role,
                  content: message.content,
                  timestamp: new Date(message.timestamp),
                  thinking: message.thinking ?? '',
                  toolExecutions: message.toolExecutions ?? [],
                  metadata: {},
                },
              },
              $set: {
                lastMessageAt: new Date(),
                updatedAt: new Date(),
              },
            }
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[Memory] Failed to save message to MongoDB:', msg);
          throw err; // Re-throw to trigger rollback
        }
      }

      // Add to Redis (hot cache)
      await this.redis.rpush(key, JSON.stringify(message));

      // Trim Redis to keep only last 100 messages
      const messageCount = await this.redis.llen(key);
      if (messageCount > this.REDIS_MESSAGE_LIMIT) {
        const trimCount = messageCount - this.REDIS_MESSAGE_LIMIT;
        await this.redis.ltrim(key, trimCount, -1);
        console.log(`[Memory] Trimmed ${trimCount} old messages from Redis cache for ${conversationId}`);
      }

      // Update metadata
      await this.updateMetadata(conversationId);
    } catch (error) {
      // Roll back index entry so a retry can succeed
      await this.redis.srem(idIndexKey, message.id);
      throw error;
    }
  }

  /**
   * Get all messages for a conversation from MongoDB (full history)
   * For recent hot context, messages are served from Redis cache
   */
  async getMessages(conversationId: string): Promise<ConversationMessage[]> {
    // Try Redis first (hot cache - last 100 messages)
    const key = `conversations:${conversationId}:messages`;
    const messagesJson = await this.redis.lrange(key, 0, -1);
    
    if (messagesJson.length > 0) {
      return messagesJson.map((json: string) => JSON.parse(json));
    }
    
    // If not in Redis, try to fetch from user_conversations.messages[] and populate Redis
    try {
      const db = this.getMongoDb();
      if (!db) return [];
      const filter = this.buildConversationFilter(conversationId);
      // $slice: -N returns the last N array elements (chronological tail)
      const doc = await db.collection('user_conversations').findOne(
        filter,
        { projection: { messages: { $slice: -this.REDIS_MESSAGE_LIMIT } } },
      );
      const embedded: Array<Record<string, any>> = Array.isArray(doc?.messages) ? doc.messages : [];

      if (embedded.length > 0) {
        const dbMessages: ConversationMessage[] = embedded.map((m) => ({
          id: (m.id ?? m.messageId) as string | undefined,
          role: m.role,
          content: m.content ?? '',
          timestamp: m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp) || Date.now(),
          thinking: typeof m.thinking === 'string' ? m.thinking : undefined,
          toolExecutions: Array.isArray(m.toolExecutions) ? m.toolExecutions : [],
        }));

        // Populate Redis cache
        const pipeline = this.redis.pipeline();
        for (const convMsg of dbMessages) {
          pipeline.rpush(key, JSON.stringify(convMsg));
          if (convMsg.id) {
            pipeline.sadd(`${key}:ids`, convMsg.id);
          }
        }
        pipeline.expire(`${key}:ids`, this.MESSAGE_ID_INDEX_TTL);
        await pipeline.exec();

        console.log(`[Memory] Populated Redis cache with ${dbMessages.length} messages from user_conversations for ${conversationId}`);
        return dbMessages;
      }
    } catch (error) {
      console.warn('[Memory] Failed to fetch from MongoDB:', error instanceof Error ? error.message : String(error));
    }

    return [];
  }

  /**
   * Get all messages from MongoDB (full conversation history).
   * Reads the embedded `messages` array from the canonical
   * `user_conversations` document.
   */
  async getAllMessagesFromDB(conversationId: string): Promise<ConversationMessage[]> {
    const db = this.getMongoDb();
    if (!db) return [];
    const filter = this.buildConversationFilter(conversationId);
    const doc = await db.collection('user_conversations').findOne(filter);
    const embedded: Array<Record<string, any>> = Array.isArray(doc?.messages) ? doc.messages : [];

    return embedded.map((m) => ({
      id: (m.id ?? m.messageId) as string | undefined,
      role: m.role,
      content: m.content ?? '',
      timestamp: m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp) || Date.now(),
      thinking: typeof m.thinking === 'string' ? m.thinking : undefined,
      toolExecutions: Array.isArray(m.toolExecutions) ? m.toolExecutions : [],
    }));
  }

  /**
   * Get trailing summary (old trimmed messages)
   */
  async getTrailingSummary(conversationId: string): Promise<string | null> {
    const key = `conversations:${conversationId}:summary:trailing`;
    return await this.redis.get(key);
  }

  /**
   * Store trailing summary (old trimmed messages)
   */
  async setTrailingSummary(conversationId: string, summary: string): Promise<void> {
    const summaryKey = `conversations:${conversationId}:summary:trailing`;
    const metaKey = `conversations:${conversationId}:metadata`;
    
    await this.redis.set(summaryKey, summary);
    await this.redis.hset(metaKey, 'trailingSummaryGenerated', 'true');
    await this.redis.hdel(metaKey, 'needsTrailingSummaryGeneration');
    await this.redis.hdel(metaKey, 'contentToSummarize');
  }

  /**
   * Get executive summary (full conversation overview)
   */
  async getExecutiveSummary(conversationId: string): Promise<string | null> {
    const key = `conversations:${conversationId}:summary:executive`;
    return await this.redis.get(key);
  }

  /**
   * Store executive summary (full conversation overview)
   */
  async setExecutiveSummary(conversationId: string, summary: string): Promise<void> {
    const summaryKey = `conversations:${conversationId}:summary:executive`;
    await this.redis.set(summaryKey, summary);
    console.log(`[Memory] Updated executive summary for ${conversationId}`);
  }

  /**
   * Get conversation metadata
   */
  async getMetadata(conversationId: string): Promise<ConversationMetadata | null> {
    const key = `conversations:${conversationId}:metadata`;
    const data = await this.redis.hgetall(key);
    
    if (Object.keys(data).length === 0) {
      return null;
    }
    
    return {
      conversationId,
      messageCount: parseInt(data.messageCount || '0'),
      lastUpdated: parseInt(data.lastUpdated || '0'),
      summaryGenerated: data.summaryGenerated === 'true',
      totalTokens: data.totalTokens ? parseInt(data.totalTokens) : undefined,
      title: data.title || undefined,
      titleSetByUser: data.titleSetByUser === 'true' || undefined
    };
  }

  /**
   * Update conversation metadata.
   * - Writes hot stats (messageCount, totalTokens, lastUpdated) to Redis.
   * - Writes `metadata.messageCount` + `updatedAt` directly onto the
   *   `user_conversations` document. No separate conversations collection.
   */
  private async updateMetadata(conversationId: string): Promise<void> {
    const key = `conversations:${conversationId}:metadata`;
    const messageCount = await this.redis.llen(`conversations:${conversationId}:messages`);

    // Calculate total tokens
    const messages = await this.getMessages(conversationId);
    const totalTokens = await this.countMessagesTokens(messages);

    await this.redis.hset(key, {
      messageCount: messageCount.toString(),
      lastUpdated: Date.now().toString(),
      totalTokens: totalTokens.toString(),
    });

    // Reflect the count onto the canonical user_conversations doc.
    try {
      const db = this.getMongoDb();
      if (!db) return;
      const filter = this.buildConversationFilter(conversationId);
      await db.collection('user_conversations').updateOne(
        filter,
        {
          $set: {
            'metadata.messageCount': messageCount,
            updatedAt: new Date(),
          },
        },
      );
    } catch (err) {
      console.warn('[Memory] Failed to update metadata on user_conversations:',
        err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Check if conversation needs summarization and trimming.
   * Returns true when total tokens exceed MAX_CONTEXT_TOKENS + SUMMARY_CUSHION_TOKENS.
   */
  async needsSummarization(conversationId: string): Promise<boolean> {
    const messages = await this.getMessages(conversationId);
    const totalTokens = await this.countMessagesTokens(messages);
    
    // Trigger summarization when we exceed the context limit + cushion
    return totalTokens > (this.MAX_CONTEXT_TOKENS + this.SUMMARY_CUSHION_TOKENS);
  }
  
  /**
   * Trim messages and generate summary to bring conversation under token limit.
   * This includes any existing summary in the summarization.
   */
  async trimAndSummarize(conversationId: string): Promise<void> {
    const messages = await this.getMessages(conversationId);
    const existingSummary = await this.getTrailingSummary(conversationId);
    
    // Calculate how many tokens we need to keep for recent context
    let recentTokens = 0;
    let keepFromIndex = messages.length;
    
    // Work backwards to find where to cut
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = await this.countMessageTokens(messages[i]);
      
      if (recentTokens + msgTokens <= this.MAX_CONTEXT_TOKENS) {
        recentTokens += msgTokens;
        keepFromIndex = i;
      } else {
        break;
      }
    }
    
    // If all messages fit, no need to summarize
    if (keepFromIndex === 0) {
      return;
    }
    
    // Messages to summarize (everything before keepFromIndex)
    const messagesToSummarize = messages.slice(0, keepFromIndex);
    
    if (messagesToSummarize.length === 0) {
      return;
    }
    
    // Keep only recent messages in Redis
    const messagesToKeep = messages.slice(keepFromIndex);
    
    // Clear old messages and store only recent ones
    const messagesKey = `conversations:${conversationId}:messages`;
    await this.redis.del(messagesKey);
    await this.redis.del(`${messagesKey}:ids`);

    if (messagesToKeep.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const msg of messagesToKeep) {
        pipeline.rpush(messagesKey, JSON.stringify(msg));
        if (msg.id) {
          pipeline.sadd(`${messagesKey}:ids`, msg.id);
        }
      }
      pipeline.expire(`${messagesKey}:ids`, this.MESSAGE_ID_INDEX_TTL);
      await pipeline.exec();
    }
    
    // Build summary content (include existing summary if present)
    let contentToSummarize = '';
    
    if (existingSummary) {
      contentToSummarize += `Previous summary: ${existingSummary}\n\n`;
    }
    
    contentToSummarize += messagesToSummarize
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');
    
    // Return the content to summarize (caller will invoke LLM)
    // Store a marker that we need to generate trailing summary
    const metaKey = `conversations:${conversationId}:metadata`;
    await this.redis.hset(metaKey, 'needsTrailingSummaryGeneration', 'true');
    await this.redis.hset(metaKey, 'contentToSummarize', contentToSummarize);
    
    // Update metadata
    await this.updateMetadata(conversationId);
  }
  
  /**
   * Get content that needs to be summarized (after trimAndSummarize was called)
   */
  async getContentToSummarize(conversationId: string): Promise<string | null> {
    const metaKey = `conversations:${conversationId}:metadata`;
    return await this.redis.hget(metaKey, 'contentToSummarize');
  }
  
  /**
   * Check if trailing summary generation is pending
   */
  async needsSummaryGeneration(conversationId: string): Promise<boolean> {
    const metaKey = `conversations:${conversationId}:metadata`;
    const value = await this.redis.hget(metaKey, 'needsTrailingSummaryGeneration');
    return value === 'true';
  }

  /**
   * Perform summarization if needed - complete workflow in one call.
   * @param conversationId The conversation to check and summarize
   * @param llmInvoker A function that takes a prompt and returns the LLM's response
   * @returns true if summarization was performed, false if not needed
   */
  async summarizeIfNeeded(
    conversationId: string,
    llmInvoker: (prompt: string) => Promise<string>
  ): Promise<boolean> {
    try {
      const needsSummary = await this.needsSummarization(conversationId);
      
      if (!needsSummary) {
        return false;
      }
      
      const tokenCount = await this.getTokenCount(conversationId);
      console.log(`[Memory] Token limit exceeded for ${conversationId}: ${tokenCount} tokens - trimming and summarizing...`);
      
      // Trim messages to fit within token limit
      await this.trimAndSummarize(conversationId);
      
      // Check if summary generation is needed
      const needsGeneration = await this.needsSummaryGeneration(conversationId);
      if (!needsGeneration) {
        console.log(`[Memory] No summary generation needed for ${conversationId}`);
        return false;
      }
      
      // Get content to summarize (includes previous summary if exists)
      const contentToSummarize = await this.getContentToSummarize(conversationId);
      
      if (!contentToSummarize) {
        return false;
      }
      
      // Create summary prompt
      const summaryPrompt = this.buildSummaryPrompt(contentToSummarize);
      
      // Generate summary using the provided LLM invoker
      const summary = await llmInvoker(summaryPrompt);
      
      // Store the trailing summary
      await this.setTrailingSummary(conversationId, summary);
      
      const newTokenCount = await this.getTokenCount(conversationId);
      console.log(`[Memory] Summarization complete for ${conversationId}: trimmed to ${newTokenCount} tokens`);
      
      return true;
    } catch (error) {
      console.error('[Memory] Summarization error:', error);
      return false;
    }
  }

  /**
   * Generate executive summary (full conversation overview).
   * Should be called after 3rd+ AI responses.
   * @param llmInvoker A function that takes a prompt and returns the LLM's response
   */
  async generateExecutiveSummary(
    conversationId: string,
    llmInvoker: (prompt: string) => Promise<string>
  ): Promise<void> {
    try {
      const messages = await this.getMessages(conversationId);
      
      if (messages.length === 0) {
        return;
      }
      
      // Build full conversation text
      const conversationText = messages
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n');
      
      const prompt = `Provide a comprehensive executive summary of the following conversation. Focus on:
- User's goals and preferences
- Key topics discussed
- Important decisions or conclusions
- Context that would be useful for future interactions

Keep it concise but informative (200-400 words). Only respond with the summary itself:

${conversationText}`;
      
      const summary = await llmInvoker(prompt);
      await this.setExecutiveSummary(conversationId, summary);
      
      console.log(`[Memory] Generated executive summary for ${conversationId}`);
    } catch (error) {
      console.error('[Memory] Executive summary generation error:', error);
    }
  }

  /**
   * Build the prompt for summarization (can be overridden or customized)
   */
  private buildSummaryPrompt(contentToSummarize: string): string {
    return `Summarize the following conversation history concisely. Focus on information about the user, key topics, decisions, and important context. Retain key information from previous summaries if they exist. Only respond with the summary itself. Keep it over 500 but under 1000 words:

${contentToSummarize}`;
  }

  /**
   * Get current token count for a conversation (useful for monitoring)
   */
  async getTokenCount(conversationId: string): Promise<number> {
    const messages = await this.getMessages(conversationId);
    return await this.countMessagesTokens(messages);
  }

  /**
   * Get token count for messages that would be returned by getContextForConversation
   */
  async getContextTokenCount(conversationId: string): Promise<number> {
    const contextMessages = await this.getContextForConversation(conversationId);
    return await this.countMessagesTokens(contextMessages);
  }

  /**
   * Delete a conversation (for cleanup/testing)
   */
  async deleteConversation(conversationId: string): Promise<void> {
    await this.redis.del(`conversations:${conversationId}:messages`);
    await this.redis.del(`conversations:${conversationId}:messages:ids`);
    await this.redis.del(`conversations:${conversationId}:summary:trailing`);
    await this.redis.del(`conversations:${conversationId}:summary:executive`);
    await this.redis.del(`conversations:${conversationId}:metadata`);
  }

  /**
   * Close Redis connection and free tokenizer
   */
  async close(): Promise<void> {
    freeTiktoken();
    await this.redis.quit();
  }
}
