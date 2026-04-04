import { Collection, ObjectId, Document, Filter, UpdateFilter, FindOptions } from 'mongodb';
type FindOptionsCompat = FindOptions;
/**
 * Base document interface - all MongoDB documents extend this
 */
export interface BaseDocument {
    _id?: ObjectId;
    createdAt?: Date;
    updatedAt?: Date;
}
/**
 * Tool execution step interface for AI library
 */
export interface StoredToolStep extends BaseDocument {
    step: string;
    timestamp: Date;
    progress?: number;
    data?: any;
}
/**
 * Tool execution interface for AI library
 */
export interface StoredToolExecution extends BaseDocument {
    toolId: string;
    toolType: string;
    toolName: string;
    status: 'running' | 'completed' | 'error';
    startTime: Date;
    endTime?: Date;
    duration?: number;
    steps: StoredToolStep[];
    currentStep?: string;
    progress?: number;
    streamingContent?: string;
    result?: any;
    error?: string;
    metadata?: Record<string, any>;
}
/**
 * Stored message interface for conversation history
 */
export interface StoredMessage extends BaseDocument {
    messageId?: string;
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    toolExecutions?: StoredToolExecution[];
    metadata?: {
        model?: string;
        tokens?: {
            input?: number;
            output?: number;
            total?: number;
        };
        toolCalls?: string[];
        source?: any;
    };
}
/**
 * Conversation metadata interface
 */
export interface Conversation extends BaseDocument {
    conversationId: string;
    title?: string;
    userId?: string;
    metadata?: {
        application?: string;
        messageCount?: number;
    };
}
/**
 * Stored log entry interface for system/generation logs
 */
export interface StoredLog extends BaseDocument {
    logId: string;
    generationId?: string;
    conversationId?: string;
    level: 'info' | 'warn' | 'error' | 'debug' | 'trace';
    category: string;
    message: string;
    timestamp: Date;
    nodeId?: string;
    metadata?: {
        duration?: number;
        statusCode?: number;
        error?: any;
        [key: string]: any;
    };
}
/**
 * Stored thought/reasoning interface for LLM thinking content
 * Stored separately from messages to keep conversation context clean
 */
export interface StoredThought extends BaseDocument {
    thoughtId: string;
    messageId?: string;
    conversationId: string;
    generationId?: string;
    source: 'chat' | 'router' | 'toolPicker';
    content: string;
    timestamp: Date;
    metadata?: {
        model?: string;
        [key: string]: any;
    };
}
/**
 * Generation metadata interface for tracking AI generations
 */
export interface Generation extends BaseDocument {
    generationId: string;
    conversationId: string;
    status: 'pending' | 'streaming' | 'completed' | 'failed';
    model?: string;
    nodeId?: string;
    startTime: Date;
    endTime?: Date;
    duration?: number;
    tokensUsed?: number;
    error?: string;
    metadata?: {
        [key: string]: any;
    };
}
/**
 * Universal database manager for MongoDB operations
 * Supports messages, conversations, logs, generations, and generic collections
 */
declare class DatabaseManager {
    private mongoUrl;
    private dbName;
    private client;
    private db;
    private collections;
    private connectionPromise;
    private readonly COLLECTIONS;
    constructor(mongoUrl?: string, dbName?: string);
    /**
     * Connect to MongoDB and initialize collections
     */
    connect(): Promise<void>;
    /**
     * Initialize collections with indexes
     */
    private initializeCollections;
    /**
     * Ensure connection is established
     */
    private ensureConnected;
    /**
     * Get a collection by name (with type safety)
     */
    private getCollection;
    /**
     * Get or create a custom collection
     */
    collection<T extends Document = Document>(name: string): Promise<Collection<T>>;
    /**
     * Insert a single document into any collection
     */
    insertOne<T extends Document>(collectionName: string, document: Omit<T, '_id'>): Promise<ObjectId>;
    /**
     * Insert multiple documents into any collection
     */
    insertMany<T extends Document>(collectionName: string, documents: Omit<T, '_id'>[]): Promise<ObjectId[]>;
    /**
     * Find documents in any collection
     */
    find<T extends Document>(collectionName: string, filter?: Filter<T>, options?: FindOptionsCompat): Promise<T[]>;
    /**
     * Find a single document in any collection
     */
    findOne<T extends Document>(collectionName: string, filter: Filter<T>): Promise<T | null>;
    /**
     * Update documents in any collection
     */
    updateMany<T extends Document>(collectionName: string, filter: Filter<T>, update: UpdateFilter<T>): Promise<number>;
    /**
     * Update a single document in any collection
     */
    updateOne<T extends Document>(collectionName: string, filter: Filter<T>, update: UpdateFilter<T>, upsert?: boolean): Promise<boolean>;
    /**
     * Delete documents from any collection
     */
    deleteMany<T extends Document>(collectionName: string, filter: Filter<T>): Promise<number>;
    /**
     * Delete a single document from any collection
     */
    deleteOne<T extends Document>(collectionName: string, filter: Filter<T>): Promise<boolean>;
    /**
     * Count documents in any collection
     */
    count<T extends Document>(collectionName: string, filter?: Filter<T>): Promise<number>;
    /**
     * Store a message in the database
     */
    storeMessage(message: Omit<StoredMessage, '_id'>): Promise<ObjectId>;
    /**
     * Store multiple messages in bulk
     */
    storeMessages(messages: Omit<StoredMessage, '_id'>[]): Promise<void>;
    /**
     * Get messages for a conversation
     * @param limit - Maximum number of messages to retrieve (0 = all)
     * @param skip - Number of messages to skip (for pagination)
     */
    getMessages(conversationId: string, limit?: number, skip?: number): Promise<StoredMessage[]>;
    /**
     * Get the last N messages for a conversation
     */
    getLastMessages(conversationId: string, count: number): Promise<StoredMessage[]>;
    /**
     * Get message count for a conversation
     */
    getMessageCount(conversationId: string): Promise<number>;
    /**
     * Create or update a conversation
     */
    upsertConversation(conversation: Omit<Conversation, '_id'>): Promise<void>;
    /**
     * Update conversation title
     */
    updateConversationTitle(conversationId: string, title: string): Promise<void>;
    /**
     * Get a conversation by ID
     */
    getConversation(conversationId: string): Promise<Conversation | null>;
    /**
     * Get all conversations (sorted by most recent)
     */
    getConversations(limit?: number, skip?: number): Promise<Conversation[]>;
    /**
     * Delete a conversation and all its messages
     */
    deleteConversation(conversationId: string): Promise<void>;
    /**
     * Store a log entry
     */
    storeLog(log: Omit<StoredLog, '_id'>): Promise<ObjectId>;
    /**
     * Store multiple log entries
     */
    storeLogs(logs: Omit<StoredLog, '_id'>[]): Promise<ObjectId[]>;
    /**
     * Get logs by generation ID
     */
    getLogsByGeneration(generationId: string, limit?: number): Promise<StoredLog[]>;
    /**
     * Get logs by conversation ID
     */
    getLogsByConversation(conversationId: string, limit?: number): Promise<StoredLog[]>;
    /**
     * Get logs by level
     */
    getLogsByLevel(level: StoredLog['level'], limit?: number): Promise<StoredLog[]>;
    /**
     * Get logs with filters
     */
    getLogs(filter?: Partial<StoredLog>, limit?: number, skip?: number): Promise<StoredLog[]>;
    /**
     * Delete old logs (older than specified date)
     */
    deleteOldLogs(olderThan: Date): Promise<number>;
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
     * Store a generation entry
     */
    storeGeneration(generation: Omit<Generation, '_id'>): Promise<ObjectId>;
    /**
     * Update generation status
     */
    updateGenerationStatus(generationId: string, status: Generation['status'], metadata?: Partial<Generation>): Promise<boolean>;
    /**
     * Get a generation by ID
     */
    getGeneration(generationId: string): Promise<Generation | null>;
    /**
     * Get generations by conversation ID
     */
    getGenerationsByConversation(conversationId: string, limit?: number): Promise<Generation[]>;
    /**
     * Get active generations (pending or streaming)
     */
    getActiveGenerations(): Promise<Generation[]>;
    /**
     * Delete old generations (older than specified date)
     */
    deleteOldGenerations(olderThan: Date): Promise<number>;
    /**
     * Store a thought/reasoning entry
     */
    storeThought(thought: Omit<StoredThought, '_id'>): Promise<ObjectId>;
    /**
     * Store multiple thoughts in bulk
     */
    storeThoughts(thoughts: Omit<StoredThought, '_id'>[]): Promise<void>;
    /**
     * Get thought by ID
     */
    getThought(thoughtId: string): Promise<StoredThought | null>;
    /**
     * Get thoughts for a specific message
     */
    getThoughtsByMessage(messageId: string): Promise<StoredThought[]>;
    /**
     * Get thoughts for a conversation
     */
    getThoughtsByConversation(conversationId: string, limit?: number): Promise<StoredThought[]>;
    /**
     * Get thoughts for a generation
     */
    getThoughtsByGeneration(generationId: string): Promise<StoredThought[]>;
    /**
     * Get thoughts by source (chat, router, toolPicker)
     */
    getThoughtsBySource(source: string, conversationId?: string, limit?: number): Promise<StoredThought[]>;
    /**
     * Delete old thoughts (older than specified date)
     */
    deleteOldThoughts(olderThan: Date): Promise<number>;
    /**
     * Close database connection
     */
    close(): Promise<void>;
}
/**
 * Get the singleton database instance
 * @param mongoUrl - MongoDB connection URL (default: from env or localhost)
 * @param dbName - Database name (default: from env or 'redbtn_ai')
 */
export declare function getDatabase(mongoUrl?: string, dbName?: string): DatabaseManager;
/**
 * Reset the singleton instance (useful for testing)
 */
export declare function resetDatabase(): void;
export { DatabaseManager };
