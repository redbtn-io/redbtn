import Redis from 'ioredis';
import { LogEntry, LogLevel, LogCategory, Generation, ConversationGenerationState } from './types';
/**
 * The most fantastic logging system known to man
 *
 * Features:
 * - Redis pub/sub for real-time log streaming
 * - 30-day TTL for all logs
 * - Generation-level tracking with unique IDs
 * - Thought logs separate from response logs
 * - Color tag support for frontends
 * - Conversation-level aggregated logs
 * - Concurrent generation prevention
 */
export declare class Logger {
    private redis;
    constructor(redis: Redis);
    /**
     * Generate a unique generation ID
     */
    generateGenerationId(): string;
    /**
     * Generate a unique log ID
     */
    private generateLogId;
    /**
     * Start a new generation
     * Returns null if a generation is already in progress for this conversation
     * Automatically cleans up stale generations (older than 5 minutes)
     */
    startGeneration(conversationId: string, generationId?: string): Promise<string | null>;
    /**
     * Complete a generation
     */
    completeGeneration(generationId: string, data: {
        response?: string;
        thinking?: string;
        route?: string;
        toolsUsed?: string[];
        model?: string;
        tokens?: Generation['tokens'];
    }): Promise<void>;
    /**
     * Fail a generation
     */
    failGeneration(generationId: string, error: string): Promise<void>;
    /**
     * Log a message
     */
    log(params: {
        level: LogLevel;
        category: LogCategory;
        message: string;
        generationId?: string;
        conversationId?: string;
        metadata?: Record<string, any>;
    }): Promise<void>;
    /**
     * Log thinking/reasoning separately from responses
     */
    logThought(params: {
        content: string;
        source: string;
        generationId: string;
        conversationId: string;
        metadata?: Record<string, any>;
    }): Promise<void>;
    /**
     * Get all logs for a generation
     */
    getGenerationLogs(generationId: string): Promise<LogEntry[]>;
    /**
     * Get all logs for a conversation
     */
    getConversationLogs(conversationId: string, limit?: number): Promise<LogEntry[]>;
    /**
     * Get generation data
     */
    getGeneration(generationId: string): Promise<Generation | null>;
    /**
     * Get conversation generation state
     */
    getConversationGenerationState(conversationId: string): Promise<ConversationGenerationState | null>;
    /**
     * Subscribe to logs for a generation (real-time streaming)
     */
    subscribeToGeneration(generationId: string): AsyncGenerator<LogEntry>;
    /**
     * Subscribe to all logs for a conversation (real-time streaming)
     */
    subscribeToConversation(conversationId: string): AsyncGenerator<LogEntry>;
}
