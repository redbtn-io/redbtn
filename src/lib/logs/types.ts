/**
 * Log types and data structures for the Red AI logging system
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

export type LogCategory = 
  | 'router'      // Routing decisions
  | 'tool'        // Tool execution
  | 'chat'        // Chat responses
  | 'thought'     // LLM thinking/reasoning
  | 'memory'      // Memory operations
  | 'system'      // System events
  | 'generation'; // Generation lifecycle

export interface LogEntry {
  id: string;                    // Unique log ID
  timestamp: number;             // Unix timestamp
  level: LogLevel;
  category: LogCategory;
  message: string;               // Log message (may contain color tags)
  generationId?: string;         // Associated generation ID
  conversationId?: string;       // Associated conversation ID
  metadata?: Record<string, any>; // Additional context
}

export interface Generation {
  id: string;                    // Unique generation ID (gen_timestamp_random)
  conversationId: string;        // Associated conversation
  status: 'generating' | 'completed' | 'error';
  startedAt: number;
  completedAt?: number;
  error?: string;
  
  // Output tracking
  response?: string;             // Final response text
  thinking?: string;             // Extracted thinking content
  
  // Metadata
  route?: string;                // Router decision (chat, web_search, etc.)
  toolsUsed?: string[];          // Tools executed
  model?: string;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
}

export interface ConversationGenerationState {
  conversationId: string;
  currentGenerationId?: string;  // Currently generating (if any)
  lastGenerationId?: string;     // Most recent generation
  generationCount: number;
}

/**
 * Redis key patterns
 */
export const RedisKeys = {
  // Log storage
  log: (logId: string) => `log:${logId}`,
  generationLogs: (genId: string) => `generation:${genId}:logs`,
  conversationLogs: (convId: string) => `conversation:${convId}:logs`,
  
  // Generation tracking
  generation: (genId: string) => `generation:${genId}`,
  conversationGeneration: (convId: string) => `conversation:${convId}:generation`,
  
  // Pub/sub channels
  logChannel: (genId: string) => `logs:generation:${genId}`,
  conversationLogChannel: (convId: string) => `logs:conversation:${convId}`,
  allLogsChannel: 'logs:all',
};

/**
 * TTL values (in seconds)
 */
export const TTL = {
  LOG: 30 * 24 * 60 * 60,        // 30 days for individual logs
  GENERATION: 30 * 24 * 60 * 60, // 30 days for generation data
  LOG_LIST: 30 * 24 * 60 * 60,   // 30 days for log lists
};
