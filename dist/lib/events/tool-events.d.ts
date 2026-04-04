/**
 * Unified Tool Event Protocol
 *
 * Standardized event format for all tool executions (thinking, web search,
 * database queries, code execution, etc.). Tools publish these events to
 * Redis pub/sub for real-time client updates.
 */
export type ToolEventType = 'tool_start' | 'tool_progress' | 'tool_complete' | 'tool_error';
export type ToolType = 'thinking' | 'web_search' | 'database_query' | 'code_execution' | 'file_operation' | 'api_call' | 'memory_retrieval' | 'custom';
/**
 * Base interface for all tool events
 */
export interface BaseToolEvent {
    type: ToolEventType;
    toolType: ToolType;
    toolName: string;
    toolId: string;
    messageId: string;
    conversationId: string;
    timestamp: number;
}
/**
 * Tool execution start event
 */
export interface ToolStartEvent extends BaseToolEvent {
    type: 'tool_start';
    metadata?: {
        input?: any;
        expectedDuration?: number;
        [key: string]: any;
    };
}
/**
 * Progress update during tool execution
 */
export interface ToolProgressEvent extends BaseToolEvent {
    type: 'tool_progress';
    step: string;
    progress?: number;
    data?: any;
    streamingContent?: string;
}
/**
 * Tool execution completion event
 */
export interface ToolCompleteEvent extends BaseToolEvent {
    type: 'tool_complete';
    result?: any;
    metadata?: {
        tokensUsed?: number;
        sitesSearched?: number;
        recordsQueried?: number;
        [key: string]: any;
    };
}
/**
 * Tool execution error event
 */
export interface ToolErrorEvent extends BaseToolEvent {
    type: 'tool_error';
    error: string;
    errorCode?: string;
}
/**
 * Union type of all tool events
 */
export type ToolEvent = ToolStartEvent | ToolProgressEvent | ToolCompleteEvent | ToolErrorEvent;
/**
 * Helper to create tool event IDs
 */
export declare const createToolId: (toolType: ToolType, messageId: string) => string;
