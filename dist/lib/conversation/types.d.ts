/**
 * Conversation-level streaming types and Redis key patterns.
 *
 * Unlike run streams (scoped to a single execution), conversation streams
 * are persistent channels that any producer can publish to -- runs, automations,
 * the push_message tool, or external triggers.
 */
export declare const ConversationKeys: {
    /** Pub/sub channel for real-time events */
    readonly stream: (conversationId: string) => string;
    /** Event list for replay on reconnection (short TTL) */
    readonly events: (conversationId: string) => string;
};
export declare const ConversationConfig: {
    /** Events list TTL -- just enough for reconnection, not long-term history */
    readonly EVENTS_TTL_SECONDS: number;
};
export interface ConversationMessageEvent {
    type: 'message';
    messageId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    metadata?: Record<string, unknown>;
    timestamp: number;
}
export interface ConversationMessageStartEvent {
    type: 'message_start';
    messageId: string;
    role?: string;
    sourceRunId?: string;
    timestamp: number;
}
export interface ConversationMessageChunkEvent {
    type: 'message_chunk';
    messageId: string;
    content: string;
    /** When true, this chunk is thinking/reasoning text (shown in collapsible bubble) */
    thinking?: boolean;
    timestamp: number;
}
export interface ConversationMessageCompleteEvent {
    type: 'message_complete';
    messageId: string;
    finalContent?: string;
    timestamp: number;
}
export interface ConversationMessageStoredEvent {
    type: 'message_stored';
    messageId: string;
    timestamp: number;
}
export interface ConversationTypingEvent {
    type: 'typing';
    isTyping: boolean;
    sourceRunId?: string;
    timestamp: number;
}
export interface ConversationStatusEvent {
    type: 'status';
    action: string;
    description?: string;
    timestamp: number;
}
export interface ConversationRunStartEvent {
    type: 'run_start';
    runId: string;
    messageId: string;
    graphId: string;
    graphName: string;
    timestamp: number;
}
export interface ConversationThinkingChunkEvent {
    type: 'thinking_chunk';
    runId: string;
    messageId: string;
    content: string;
    timestamp: number;
}
export interface ConversationContentChunkEvent {
    type: 'content_chunk';
    runId: string;
    messageId: string;
    content: string;
    timestamp: number;
}
export interface ConversationToolEvent {
    type: 'tool_event';
    runId: string;
    event: {
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
    };
    timestamp: number;
}
export interface ConversationRunCompleteEvent {
    type: 'run_complete';
    runId: string;
    messageId: string;
    finalContent?: string;
    timestamp: number;
}
export interface ConversationRunErrorEvent {
    type: 'run_error';
    runId: string;
    messageId: string;
    error: string;
    timestamp: number;
}
export type ConversationEvent = ConversationMessageEvent | ConversationMessageStartEvent | ConversationMessageChunkEvent | ConversationMessageCompleteEvent | ConversationMessageStoredEvent | ConversationTypingEvent | ConversationStatusEvent | ConversationRunStartEvent | ConversationThinkingChunkEvent | ConversationContentChunkEvent | ConversationToolEvent | ConversationRunCompleteEvent | ConversationRunErrorEvent;
