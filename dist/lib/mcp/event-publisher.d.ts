/**
 * MCP Tool Event Publisher
 *
 * Publishes tool events and logs from MCP servers to Redis
 * so they appear in the UI and logs API
 */
import { Redis } from 'ioredis';
export declare class McpEventPublisher {
    private redis;
    private toolId;
    private toolType;
    private toolName;
    private messageId?;
    private conversationId?;
    private generationId?;
    private startTime;
    constructor(redis: Redis, toolType: string, toolName: string, meta?: {
        conversationId?: string;
        generationId?: string;
        messageId?: string;
    });
    /**
     * Publish tool start event
     */
    publishStart(options?: {
        input?: any;
        expectedDuration?: number;
    }): Promise<void>;
    /**
     * Publish tool progress event
     */
    publishProgress(message: string, options?: {
        progress?: number;
        data?: any;
        streamingContent?: string;
    }): Promise<void>;
    /**
     * Publish tool complete event
     */
    publishComplete(result?: any, metadata?: any): Promise<void>;
    /**
     * Publish tool error event
     */
    publishError(error: string | Error | {
        error: string;
        errorCode?: string;
    }): Promise<void>;
    /**
     * Publish log entry
     */
    publishLog(level: 'info' | 'success' | 'warn' | 'error', message: string, metadata?: any): Promise<void>;
    /**
     * Get elapsed time since tool start
     */
    getDuration(): number;
}
