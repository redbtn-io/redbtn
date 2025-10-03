/**
 * @file src/lib/memory.ts
 * @description Conversation memory management with Redis storage
 */

import Redis from 'ioredis';
import { encoding_for_model } from 'tiktoken';

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
  summaryUpToMessage?: number; // Index of last message included in summary
  totalTokens?: number; // Total tokens in conversation
}

export class MemoryManager {
  private redis: Redis;
  private readonly MAX_RECENT_MESSAGES = parseInt(process.env.MAX_RECENT_MESSAGES || '10');
  private readonly SUMMARY_THRESHOLD_MESSAGES = parseInt(process.env.SUMMARY_THRESHOLD_MESSAGES || '15');
  private readonly SUMMARY_THRESHOLD_TOKENS = parseInt(process.env.SUMMARY_THRESHOLD_TOKENS || '3000');
  private tokenEncoder: any;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
    // Initialize tiktoken encoder for GPT-4/GPT-3.5 compatible counting
    this.tokenEncoder = encoding_for_model('gpt-3.5-turbo');
  }

  /**
   * Count tokens in a message
   */
  private countMessageTokens(message: ConversationMessage): number {
    try {
      // Format: role + content + overhead (4 tokens per message for formatting)
      const roleTokens = this.tokenEncoder.encode(message.role).length;
      const contentTokens = this.tokenEncoder.encode(message.content).length;
      return roleTokens + contentTokens + 4;
    } catch (error) {
      // Fallback: rough estimate (1 token ≈ 4 characters)
      return Math.ceil((message.role.length + message.content.length) / 4);
    }
  }

  /**
   * Count tokens in multiple messages
   */
  private countMessagesTokens(messages: ConversationMessage[]): number {
    return messages.reduce((total, msg) => total + this.countMessageTokens(msg), 0);
  }

  /**
   * Get conversation context: summary (if exists) + last K messages
   */
  async getContextForConversation(conversationId: string): Promise<ConversationMessage[]> {
    const messages = await this.getMessages(conversationId);
    
    if (messages.length <= this.MAX_RECENT_MESSAGES) {
      // Return all messages if we have 10 or fewer
      return messages;
    }

    // Get recent messages
    const recentMessages = messages.slice(-this.MAX_RECENT_MESSAGES);
    
    // Get summary if it exists
    const summary = await this.getSummary(conversationId);
    
    if (summary) {
      // Return summary as system message + recent messages
      return [
        {
          role: 'system',
          content: `Previous conversation context: ${summary}`,
          timestamp: Date.now()
        },
        ...recentMessages
      ];
    }
    
    // No summary yet, just return recent messages
    return recentMessages;
  }

  /**
   * Add a new message to the conversation
   */
  async addMessage(conversationId: string, message: ConversationMessage): Promise<void> {
    const key = `conversation:${conversationId}:messages`;
    
    // Add message to Redis list
    await this.redis.rpush(key, JSON.stringify(message));
    
    // Update metadata
    await this.updateMetadata(conversationId);
  }

  /**
   * Get all messages for a conversation
   */
  async getMessages(conversationId: string): Promise<ConversationMessage[]> {
    const key = `conversation:${conversationId}:messages`;
    const messagesJson = await this.redis.lrange(key, 0, -1);
    
    return messagesJson.map((json: string) => JSON.parse(json));
  }

  /**
   * Get conversation summary
   */
  async getSummary(conversationId: string): Promise<string | null> {
    const key = `conversation:${conversationId}:summary`;
    return await this.redis.get(key);
  }

  /**
   * Store conversation summary
   */
  async setSummary(conversationId: string, summary: string, upToMessageIndex: number): Promise<void> {
    const summaryKey = `conversation:${conversationId}:summary`;
    const metaKey = `conversation:${conversationId}:metadata`;
    
    await this.redis.set(summaryKey, summary);
    await this.redis.hset(metaKey, 'summaryGenerated', 'true');
    await this.redis.hset(metaKey, 'summaryUpToMessage', upToMessageIndex.toString());
  }

  /**
   * Get conversation metadata
   */
  async getMetadata(conversationId: string): Promise<ConversationMetadata | null> {
    const key = `conversation:${conversationId}:metadata`;
    const data = await this.redis.hgetall(key);
    
    if (Object.keys(data).length === 0) {
      return null;
    }
    
    return {
      conversationId,
      messageCount: parseInt(data.messageCount || '0'),
      lastUpdated: parseInt(data.lastUpdated || '0'),
      summaryGenerated: data.summaryGenerated === 'true',
      summaryUpToMessage: data.summaryUpToMessage ? parseInt(data.summaryUpToMessage) : undefined,
      totalTokens: data.totalTokens ? parseInt(data.totalTokens) : undefined
    };
  }

  /**
   * Update conversation metadata
   */
  private async updateMetadata(conversationId: string): Promise<void> {
    const key = `conversation:${conversationId}:metadata`;
    const messageCount = await this.redis.llen(`conversation:${conversationId}:messages`);
    
    // Calculate total tokens
    const messages = await this.getMessages(conversationId);
    const totalTokens = this.countMessagesTokens(messages);
    
    await this.redis.hset(key, {
      messageCount: messageCount.toString(),
      lastUpdated: Date.now().toString(),
      totalTokens: totalTokens.toString()
    });
  }

  /**
   * Check if conversation needs summarization
   * Triggers on EITHER message count OR token count threshold
   */
  async needsSummarization(conversationId: string): Promise<boolean> {
    const metadata = await this.getMetadata(conversationId);
    
    if (!metadata) return false;
    
    // Check if we need initial summary (message count OR token count threshold)
    if (!metadata.summaryGenerated) {
      const messageThresholdMet = metadata.messageCount > this.SUMMARY_THRESHOLD_MESSAGES;
      const tokenThresholdMet = metadata.totalTokens ? metadata.totalTokens > this.SUMMARY_THRESHOLD_TOKENS : false;
      
      if (messageThresholdMet || tokenThresholdMet) {
        return true;
      }
    }
    
    // Check if we need to update existing summary (10+ new messages OR significant tokens)
    if (metadata.summaryGenerated && metadata.summaryUpToMessage) {
      const newMessagesSinceLastSummary = metadata.messageCount - metadata.summaryUpToMessage;
      
      // Re-summarize if 10+ new messages
      if (newMessagesSinceLastSummary > 10) {
        return true;
      }
      
      // Or if new messages add significant tokens (1000+ tokens)
      if (metadata.totalTokens && newMessagesSinceLastSummary > 0) {
        const messages = await this.getMessages(conversationId);
        const newMessages = messages.slice(metadata.summaryUpToMessage);
        const newTokens = this.countMessagesTokens(newMessages);
        
        if (newTokens > 1000) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Get current token count for a conversation (useful for monitoring)
   */
  async getTokenCount(conversationId: string): Promise<number> {
    const messages = await this.getMessages(conversationId);
    return this.countMessagesTokens(messages);
  }

  /**
   * Get token count for recent messages only
   */
  async getRecentTokenCount(conversationId: string): Promise<number> {
    const messages = await this.getMessages(conversationId);
    const recentMessages = messages.slice(-this.MAX_RECENT_MESSAGES);
    return this.countMessagesTokens(recentMessages);
  }

  /**
   * Delete a conversation (for cleanup/testing)
   */
  async deleteConversation(conversationId: string): Promise<void> {
    await this.redis.del(`conversation:${conversationId}:messages`);
    await this.redis.del(`conversation:${conversationId}:summary`);
    await this.redis.del(`conversation:${conversationId}:metadata`);
  }

  /**
   * Close Redis connection and free tokenizer
   */
  async close(): Promise<void> {
    this.tokenEncoder.free();
    await this.redis.quit();
  }
}
