import Redis from 'ioredis';
import { Logger } from './logger';
/**
 * Enhanced Logger with MongoDB persistence
 *
 * Features:
 * - All original Logger functionality (Redis pub/sub, 30-day TTL)
 * - Async batch writes to MongoDB (5-second intervals)
 * - 6-month TTL in MongoDB (automatic cleanup)
 * - Graceful error handling (Redis always succeeds even if MongoDB fails)
 * - Automatic flush on shutdown
 */
export declare class PersistentLogger extends Logger {
    private db;
    private logQueue;
    private generationQueue;
    private flushInterval;
    private readonly FLUSH_INTERVAL_MS;
    private readonly MAX_BATCH_SIZE;
    private nodeId;
    constructor(redis: Redis, nodeId?: string);
    /**
     * Start the automatic flush interval
     */
    private startFlushInterval;
    /**
     * Flush queued logs and generations to MongoDB
     */
    private flushQueues;
    /**
     * Convert LogEntry to StoredLog format
     */
    private convertToStoredLog;
    /**
     * Map log levels to StoredLog format
     */
    private mapLogLevel;
    /**
     * Override log method to also queue for MongoDB persistence
     */
    log(params: {
        level: string;
        category: string;
        message: string;
        generationId?: string;
        conversationId?: string;
        metadata?: Record<string, any>;
    }): Promise<void>;
    /**
     * Override startGeneration to also track in MongoDB
     */
    startGeneration(conversationId: string, generationId?: string): Promise<string | null>;
    /**
     * Override completeGeneration to track in MongoDB
     */
    completeGeneration(generationId: string, data: {
        response?: string;
        thinking?: string;
        route?: string;
        toolsUsed?: string[];
        model?: string;
        tokens?: any;
    }): Promise<void>;
    /**
     * Override failGeneration to track in MongoDB
     */
    failGeneration(generationId: string, error: string): Promise<void>;
    /**
     * Get all conversations that have logs with counts and metadata
     */
    getConversationsWithLogs(): Promise<Array<{
        conversationId: string;
        title?: string;
        lastLogTime: Date;
        logCount: number;
        generationCount: number;
    }>>;
    /**
     * Shutdown the logger and flush all pending writes
     */
    shutdown(): Promise<void>;
}
