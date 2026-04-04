import Redis from 'ioredis';
/**
 * Message Queue - Manages in-progress message generation state in Redis
 * Allows reconnecting to ongoing generations and tracking completion status
 */
export interface MessageGenerationState {
    conversationId: string;
    messageId: string;
    status: 'generating' | 'completed' | 'error';
    content: string;
    thinking?: string;
    toolEvents?: any[];
    startedAt: number;
    completedAt?: number;
    error?: string;
    currentStatus?: {
        action: string;
        description?: string;
        reasoning?: string;
        confidence?: number;
    };
    metadata?: {
        model?: string;
        tokens?: {
            input?: number;
            output?: number;
            total?: number;
        };
    };
}
export declare class MessageQueue {
    private redis;
    private readonly STATE_TTL;
    private readonly CONTENT_KEY_PREFIX;
    private readonly INDEX_KEY_PREFIX;
    private readonly PUBSUB_PREFIX;
    private readonly STREAM_READY_PREFIX;
    constructor(redis: Redis);
    /**
     * Signal that a stream client is connected and ready to receive events
     */
    markStreamReady(messageId: string): Promise<void>;
    /**
     * Wait for stream client to be ready before starting generation
     * Returns true if ready, false if timeout
     */
    waitForStreamReady(messageId: string, timeoutMs?: number): Promise<boolean>;
    /**
     * Start tracking a new message generation
     */
    startGeneration(conversationId: string, messageId: string): Promise<void>;
    /**
     * Append content to a generating message (called as tokens stream in)
     */
    appendContent(messageId: string, chunk: string): Promise<void>;
    /**
     * Mark message generation as completed
     */
    completeGeneration(messageId: string, metadata?: MessageGenerationState['metadata']): Promise<void>;
    /**
     * Publish tool status indicator (searching, scraping, etc.)
     */
    publishToolStatus(messageId: string, toolInfo: {
        status: string;
        action: string;
        reasoning?: string;
        confidence?: number;
    }): Promise<void>;
    /**
     * Publish general status update (routing, thinking, processing, etc.)
     */
    publishStatus(messageId: string, status: {
        action: string;
        description?: string;
        reasoning?: string;
        confidence?: number;
    }): Promise<void>;
    /**
     * Publish thinking/reasoning content chunk by chunk
     */
    publishThinkingChunk(messageId: string, chunk: string): Promise<void>;
    /**
     * Publish thinking complete event (when </think> tag is closed)
     */
    publishThinkingComplete(messageId: string): Promise<void>;
    /**
     * Publish tool event to Redis pub/sub
     * Simple wrapper that doesn't require ToolEvent types
     */
    publishToolEvent(messageId: string, event: any): Promise<void>;
    /**
     * Mark message generation as failed
     */
    failGeneration(messageId: string, error: string): Promise<void>;
    /**
     * Get current state of a generating message
     */
    getMessageState(messageId: string): Promise<MessageGenerationState | null>;
    /**
     * Get all generating messages for a conversation
     */
    getGeneratingMessages(conversationId: string): Promise<MessageGenerationState[]>;
    /**
     * Clean up completed/failed message state
     */
    cleanupMessage(messageId: string): Promise<void>;
    /**
     * Subscribe to a message stream via Redis pub/sub
     * Returns an async generator that yields chunks, completion, or errors
     */
    subscribeToMessage(messageId: string): AsyncGenerator<{
        type: 'init' | 'chunk' | 'status' | 'thinking' | 'complete' | 'error' | 'tool_status' | 'tool_event';
        content?: string;
        thinking?: boolean;
        existingContent?: string;
        metadata?: MessageGenerationState['metadata'];
        error?: string;
        action?: string;
        description?: string;
        status?: string;
        event?: any;
    }>;
}
