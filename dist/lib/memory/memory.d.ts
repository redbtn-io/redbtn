/**
 * @file src/lib/memory.ts
 * @description Conversation memory management with MongoDB persistence and Redis caching
 */
import { StoredToolExecution } from './database';
export interface ConversationMessage {
    id?: string;
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp: number;
    toolExecutions?: StoredToolExecution[];
}
export interface ConversationMetadata {
    conversationId: string;
    messageCount: number;
    lastUpdated: number;
    summaryGenerated: boolean;
    totalTokens?: number;
    title?: string;
    titleSetByUser?: boolean;
}
export declare class MemoryManager {
    private redis;
    readonly redisUrl: string;
    private readonly MAX_CONTEXT_TOKENS;
    private readonly SUMMARY_CUSHION_TOKENS;
    private readonly REDIS_MESSAGE_LIMIT;
    private readonly MESSAGE_ID_INDEX_TTL;
    constructor(redisUrl: string);
    /**
     * Generate a conversation ID based on initial message content (stable hashing)
     * or create a random ID if no seed is provided
     */
    generateConversationId(seedMessage?: string): string;
    /**
     * Count tokens in a message
     */
    private countMessageTokens;
    /**
     * Count tokens in multiple messages
     */
    private countMessagesTokens;
    /**
     * Get conversation context: returns messages that fit within token limit.
     * Use getContextSummary() separately to retrieve summary for merging with system prompts.
     */
    getContextForConversation(conversationId: string): Promise<ConversationMessage[]>;
    /**
     * Get conversation summary (if exists) for manual inclusion in system prompts.
     * Returns null if no summary has been generated yet.
     * This returns the TRAILING summary (old trimmed messages).
     */
    getContextSummary(conversationId: string): Promise<string | null>;
    /**
     * Add a new message to the conversation
     * Stores in both MongoDB (persistence) and Redis (hot cache of last 100 messages)
     */
    addMessage(conversationId: string, message: ConversationMessage): Promise<void>;
    /**
     * Get all messages for a conversation from MongoDB (full history)
     * For recent hot context, messages are served from Redis cache
     */
    getMessages(conversationId: string): Promise<ConversationMessage[]>;
    /**
     * Get all messages from MongoDB (for full conversation history)
     */
    getAllMessagesFromDB(conversationId: string): Promise<ConversationMessage[]>;
    /**
     * Get trailing summary (old trimmed messages)
     */
    getTrailingSummary(conversationId: string): Promise<string | null>;
    /**
     * Store trailing summary (old trimmed messages)
     */
    setTrailingSummary(conversationId: string, summary: string): Promise<void>;
    /**
     * Get executive summary (full conversation overview)
     */
    getExecutiveSummary(conversationId: string): Promise<string | null>;
    /**
     * Store executive summary (full conversation overview)
     */
    setExecutiveSummary(conversationId: string, summary: string): Promise<void>;
    /**
     * Get conversation metadata
     */
    getMetadata(conversationId: string): Promise<ConversationMetadata | null>;
    /**
     * Update conversation metadata
     */
    private updateMetadata;
    /**
     * Check if conversation needs summarization and trimming.
     * Returns true when total tokens exceed MAX_CONTEXT_TOKENS + SUMMARY_CUSHION_TOKENS.
     */
    needsSummarization(conversationId: string): Promise<boolean>;
    /**
     * Trim messages and generate summary to bring conversation under token limit.
     * This includes any existing summary in the summarization.
     */
    trimAndSummarize(conversationId: string): Promise<void>;
    /**
     * Get content that needs to be summarized (after trimAndSummarize was called)
     */
    getContentToSummarize(conversationId: string): Promise<string | null>;
    /**
     * Check if trailing summary generation is pending
     */
    needsSummaryGeneration(conversationId: string): Promise<boolean>;
    /**
     * Perform summarization if needed - complete workflow in one call.
     * @param conversationId The conversation to check and summarize
     * @param llmInvoker A function that takes a prompt and returns the LLM's response
     * @returns true if summarization was performed, false if not needed
     */
    summarizeIfNeeded(conversationId: string, llmInvoker: (prompt: string) => Promise<string>): Promise<boolean>;
    /**
     * Generate executive summary (full conversation overview).
     * Should be called after 3rd+ AI responses.
     * @param llmInvoker A function that takes a prompt and returns the LLM's response
     */
    generateExecutiveSummary(conversationId: string, llmInvoker: (prompt: string) => Promise<string>): Promise<void>;
    /**
     * Build the prompt for summarization (can be overridden or customized)
     */
    private buildSummaryPrompt;
    /**
     * Get current token count for a conversation (useful for monitoring)
     */
    getTokenCount(conversationId: string): Promise<number>;
    /**
     * Get token count for messages that would be returned by getContextForConversation
     */
    getContextTokenCount(conversationId: string): Promise<number>;
    /**
     * Delete a conversation (for cleanup/testing)
     */
    deleteConversation(conversationId: string): Promise<void>;
    /**
     * Close Redis connection and free tokenizer
     */
    close(): Promise<void>;
}
