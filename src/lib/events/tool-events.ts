/**
 * Unified Tool Event Protocol
 * 
 * Standardized event format for all tool executions (thinking, web search, 
 * database queries, code execution, etc.). Tools publish these events to 
 * Redis pub/sub for real-time client updates.
 */

export type ToolEventType = 
  | 'tool_start'      // Tool execution begins
  | 'tool_progress'   // Incremental progress update
  | 'tool_complete'   // Tool execution finished successfully
  | 'tool_error';     // Tool execution failed

export type ToolType = 
  | 'thinking'        // AI reasoning/planning
  | 'web_search'      // Web search tool
  | 'database_query'  // Database operations
  | 'code_execution'  // Code interpreter
  | 'file_operation'  // File system operations
  | 'api_call'        // External API calls
  | 'memory_retrieval'// Memory/context retrieval
  | 'custom';         // Custom tool types

/**
 * Base interface for all tool events
 */
export interface BaseToolEvent {
  type: ToolEventType;
  toolType: ToolType;
  toolName: string;           // Human-readable tool name
  toolId: string;             // Unique identifier for this tool execution
  messageId: string;          // Associated message ID
  conversationId: string;     // Associated conversation ID
  timestamp: number;          // Unix timestamp in milliseconds
}

/**
 * Tool execution start event
 */
export interface ToolStartEvent extends BaseToolEvent {
  type: 'tool_start';
  metadata?: {
    input?: any;              // Tool input parameters (sanitized)
    expectedDuration?: number; // Estimated duration in ms
    [key: string]: any;
  };
}

/**
 * Progress update during tool execution
 */
export interface ToolProgressEvent extends BaseToolEvent {
  type: 'tool_progress';
  step: string;               // Current step description
  progress?: number;          // Optional progress percentage (0-100)
  data?: any;                 // Step-specific data to display
  streamingContent?: string;  // For streaming text output (like thinking)
}

/**
 * Tool execution completion event
 */
export interface ToolCompleteEvent extends BaseToolEvent {
  type: 'tool_complete';
  result?: any;               // Final result (sanitized)
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
  error: string;              // Error message
  errorCode?: string;         // Optional error code
}

/**
 * Union type of all tool events
 */
export type ToolEvent = 
  | ToolStartEvent 
  | ToolProgressEvent 
  | ToolCompleteEvent 
  | ToolErrorEvent;

/**
 * Helper to create tool event IDs
 */
export const createToolId = (toolType: ToolType, messageId: string): string => {
  return `${toolType}_${messageId}_${Date.now()}`;
};
