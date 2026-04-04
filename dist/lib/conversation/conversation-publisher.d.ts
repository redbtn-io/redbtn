/**
 * ConversationPublisher -- publishes messages and events to a conversation stream.
 *
 * Unlike RunPublisher (which manages run lifecycle state), this is a pure event
 * emitter. Multiple publishers can target the same conversation simultaneously.
 *
 * Events are published to:
 * - Redis pub/sub channel: conversation:stream:{conversationId}
 * - Redis list: conversation:events:{conversationId} (for replay)
 *
 * Messages can optionally be persisted to MongoDB via the conversation model.
 */
import type Redis from 'ioredis';
export interface ConversationPublisherOptions {
    redis: Redis;
    conversationId: string;
    userId?: string;
    eventsTtl?: number;
}
export declare class ConversationPublisher {
    private readonly redis;
    private readonly conversationId;
    private readonly userId?;
    private readonly channel;
    private readonly eventsKey;
    private readonly ttl;
    constructor(options: ConversationPublisherOptions);
    /**
     * Push a complete message to the conversation.
     * Published immediately and optionally persisted to MongoDB.
     */
    pushMessage(params: {
        role: 'user' | 'assistant' | 'system';
        content: string;
        messageId?: string;
        metadata?: Record<string, unknown>;
        persist?: boolean;
    }): Promise<string>;
    /** Begin streaming a message -- UI shows an empty bubble */
    startMessage(messageId: string, role?: string): Promise<void>;
    /** Stream a chunk of content to an active message */
    streamChunk(messageId: string, content: string, thinking?: boolean): Promise<void>;
    /** Complete a streaming message */
    completeMessage(messageId: string, finalContent?: string): Promise<void>;
    /** Signal a run has started in this conversation */
    publishRunStart(runId: string, messageId: string, graphId: string, graphName: string): Promise<void>;
    /** Stream a thinking/reasoning chunk from a run */
    streamThinking(runId: string, messageId: string, content: string): Promise<void>;
    /** Stream a content chunk from a run */
    streamContent(runId: string, messageId: string, content: string): Promise<void>;
    /** Publish a tool event from a run */
    publishToolEvent(runId: string, event: {
        type: 'tool_start' | 'tool_progress' | 'tool_complete' | 'tool_error';
        toolId: string;
        toolName: string;
        toolType: string;
        input?: unknown;
        step?: string;
        progress?: number;
        data?: Record<string, unknown>;
        result?: unknown;
        metadata?: Record<string, unknown>;
        error?: string;
        timestamp: number;
    }): Promise<void>;
    /** Signal a run has completed in this conversation */
    publishRunComplete(runId: string, messageId: string, finalContent?: string): Promise<void>;
    /** Signal a run has failed in this conversation */
    publishRunError(runId: string, messageId: string, error: string): Promise<void>;
    /** Show/hide typing indicator */
    setTyping(isTyping: boolean, sourceRunId?: string): Promise<void>;
    /** Send a status update */
    status(action: string, description?: string): Promise<void>;
    private publish;
    private persistMessage;
}
export declare function createConversationPublisher(options: ConversationPublisherOptions): ConversationPublisher;
