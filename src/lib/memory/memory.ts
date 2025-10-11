/**
 * @file src/lib/memory.ts
 * @description Conversation memory management with MongoDB persistence and Redis caching
 */

import Redis from 'ioredis';
import { countTokens, freeTiktoken } from '../utils/tokenizer';
import { getDatabase, StoredMessage } from './database';

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
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

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
    this.redis = new Redis(redisUrl);
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
    
    // Store in MongoDB for persistence (non-blocking, ignore errors)
    getDatabase().storeMessage({
      conversationId,
      role: message.role,
      content: message.content,
      timestamp: new Date(message.timestamp),
      metadata: {}
    }).catch(err => {
      console.warn('[Memory] Failed to save message to MongoDB:', err.message);
    });
    
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
    
    // If not in Redis, try to fetch from MongoDB and populate Redis
    try {
      const db = getDatabase();
      const dbMessages = await db.getLastMessages(conversationId, this.REDIS_MESSAGE_LIMIT);
      
      if (dbMessages.length > 0) {
        // Populate Redis cache
        const pipeline = this.redis.pipeline();
        for (const msg of dbMessages) {
          const convMsg: ConversationMessage = {
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp.getTime()
          };
          pipeline.rpush(key, JSON.stringify(convMsg));
        }
        await pipeline.exec();
        
        console.log(`[Memory] Populated Redis cache with ${dbMessages.length} messages from MongoDB for ${conversationId}`);
        
        return dbMessages.map(msg => ({
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp.getTime()
        }));
      }
    } catch (error) {
      console.warn('[Memory] Failed to fetch from MongoDB:', error instanceof Error ? error.message : String(error));
    }
    
    return [];
  }

  /**
   * Get all messages from MongoDB (for full conversation history)
   */
  async getAllMessagesFromDB(conversationId: string): Promise<ConversationMessage[]> {
    const db = getDatabase();
    const dbMessages = await db.getMessages(conversationId);
    
    return dbMessages.map(msg => ({
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp.getTime()
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
   * Update conversation metadata
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
      totalTokens: totalTokens.toString()
    });
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
    
    for (const msg of messagesToKeep) {
      await this.redis.rpush(messagesKey, JSON.stringify(msg));
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
