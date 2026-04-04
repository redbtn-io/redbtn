/**
 * Log types and data structures for the Red AI logging system
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';
export type LogCategory = 'router' | 'tool' | 'chat' | 'thought' | 'memory' | 'system' | 'generation';
export interface LogEntry {
    id: string;
    timestamp: number;
    level: LogLevel;
    category: LogCategory;
    message: string;
    generationId?: string;
    conversationId?: string;
    metadata?: Record<string, any>;
}
export interface Generation {
    id: string;
    conversationId: string;
    status: 'generating' | 'completed' | 'error';
    startedAt: number;
    completedAt?: number;
    error?: string;
    response?: string;
    thinking?: string;
    route?: string;
    toolsUsed?: string[];
    model?: string;
    tokens?: {
        input?: number;
        output?: number;
        total?: number;
    };
}
export interface ConversationGenerationState {
    conversationId: string;
    currentGenerationId?: string;
    lastGenerationId?: string;
    generationCount: number;
}
/**
 * Redis key patterns
 */
export declare const RedisKeys: {
    log: (logId: string) => string;
    generationLogs: (genId: string) => string;
    conversationLogs: (convId: string) => string;
    generation: (genId: string) => string;
    conversationGeneration: (convId: string) => string;
    logChannel: (genId: string) => string;
    conversationLogChannel: (convId: string) => string;
    allLogsChannel: string;
};
/**
 * TTL values (in seconds)
 */
export declare const TTL: {
    LOG: number;
    GENERATION: number;
    LOG_LIST: number;
};
