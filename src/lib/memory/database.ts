import { MongoClient, Db, Collection, ObjectId, Document, Filter, UpdateFilter, FindOptions } from 'mongodb';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

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
  toolType: string; // 'thinking', 'web_search', 'database_query', etc.
  toolName: string;
  status: 'running' | 'completed' | 'error';
  startTime: Date;
  endTime?: Date;
  duration?: number;
  
  // Progress tracking
  steps: StoredToolStep[];
  currentStep?: string;
  progress?: number;
  
  // Streaming content (for thinking, code output, etc.)
  streamingContent?: string;
  
  // Results and metadata
  result?: any;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Stored message interface for conversation history
 */
export interface StoredMessage extends BaseDocument {
  messageId?: string; // Original message ID from the request (e.g., msg_1234567890_abc123def)
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  toolExecutions?: StoredToolExecution[]; // Tool executions for this message
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
  messageId?: string; // Associated message ID (if linked to a specific message)
  conversationId: string;
  generationId?: string;
  source: 'chat' | 'router' | 'toolPicker'; // Where the thinking came from
  content: string; // The actual thinking/reasoning text
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

// ============================================================================
// DATABASE MANAGER CLASS
// ============================================================================

/**
 * Universal database manager for MongoDB operations
 * Supports messages, conversations, logs, generations, and generic collections
 */
class DatabaseManager {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collections: Map<string, Collection<any>> = new Map();
  private connectionPromise: Promise<void> | null = null;

  // Pre-defined collection names
  private readonly COLLECTIONS = {
    MESSAGES: 'messages',
    CONVERSATIONS: 'conversations',
    LOGS: 'logs',
    GENERATIONS: 'generations',
    THOUGHTS: 'thoughts',
  };

  constructor(private mongoUrl: string = 'mongodb://localhost:27017', private dbName: string = 'redbtn_ai') {}

  // ==========================================================================
  // CONNECTION MANAGEMENT
  // ==========================================================================

  // ==========================================================================
  // CONNECTION MANAGEMENT
  // ==========================================================================

  /**
   * Connect to MongoDB and initialize collections
   */
  async connect(): Promise<void> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = (async () => {
      try {
        console.log('[Database] Connecting to MongoDB...');
        
        // Connection options
        const options = {
          authMechanism: undefined as string | undefined,
          authSource: 'admin' as string | undefined,
        };
        
        // If URL contains username/password, set auth source
        if (this.mongoUrl.includes('@')) {
          options.authSource = 'admin';
        }
        
        this.client = new MongoClient(this.mongoUrl, {
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 10000,
        });
        
        await this.client.connect();
        
        // Test the connection
        await this.client.db('admin').admin().ping();
        
        this.db = this.client.db(this.dbName);
        
        // Initialize core collections
        await this.initializeCollections();
        
        console.log('[Database] Connected to MongoDB successfully');
      } catch (error) {
        console.error('[Database] Failed to connect to MongoDB:', error);
        console.error('[Database] Make sure MongoDB is running and authentication is configured correctly');
        console.error('[Database] Current connection string:', this.mongoUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@'));
        this.connectionPromise = null;
        throw error;
      }
    })();

    return this.connectionPromise;
  }

  /**
   * Initialize collections with indexes
   */
  private async initializeCollections(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

    // Messages collection
    const messages = this.db.collection<StoredMessage>(this.COLLECTIONS.MESSAGES);
    await messages.createIndex({ conversationId: 1, timestamp: 1 });
    await messages.createIndex({ timestamp: -1 });
    this.collections.set(this.COLLECTIONS.MESSAGES, messages);

    // Conversations collection
    const conversations = this.db.collection<Conversation>(this.COLLECTIONS.CONVERSATIONS);
    await conversations.createIndex({ conversationId: 1 }, { unique: true });
    await conversations.createIndex({ updatedAt: -1 });
    await conversations.createIndex({ userId: 1 });
    this.collections.set(this.COLLECTIONS.CONVERSATIONS, conversations);

    // Logs collection with 6-month TTL
    const logs = this.db.collection<StoredLog>(this.COLLECTIONS.LOGS);
    await logs.createIndex({ timestamp: -1 });
    await logs.createIndex({ generationId: 1 });
    await logs.createIndex({ conversationId: 1 });
    await logs.createIndex({ level: 1 });
    await logs.createIndex({ category: 1 });
    await logs.createIndex({ logId: 1 }, { unique: true });
    // TTL index: automatically delete logs after 6 months (15552000 seconds)
    await logs.createIndex({ timestamp: 1 }, { expireAfterSeconds: 15552000 });
    this.collections.set(this.COLLECTIONS.LOGS, logs);

    // Generations collection
    const generations = this.db.collection<Generation>(this.COLLECTIONS.GENERATIONS);
    await generations.createIndex({ generationId: 1 }, { unique: true });
    await generations.createIndex({ conversationId: 1 });
    await generations.createIndex({ status: 1 });
    await generations.createIndex({ startTime: -1 });
    await generations.createIndex({ nodeId: 1 });
    this.collections.set(this.COLLECTIONS.GENERATIONS, generations);

    // Thoughts collection (stores thinking/reasoning separately from messages)
    const thoughts = this.db.collection<StoredThought>(this.COLLECTIONS.THOUGHTS);
    await thoughts.createIndex({ thoughtId: 1 }, { unique: true });
    
    // Single field indexes for basic queries
    await thoughts.createIndex({ conversationId: 1 });
    await thoughts.createIndex({ messageId: 1 });
    await thoughts.createIndex({ generationId: 1 });
    await thoughts.createIndex({ timestamp: -1 });
    await thoughts.createIndex({ source: 1 });
    
    // Composite indexes for optimized multi-field queries
    await thoughts.createIndex({ messageId: 1, timestamp: -1 });           // messageId + time sort
    await thoughts.createIndex({ conversationId: 1, timestamp: -1 });      // conversation + time sort
    await thoughts.createIndex({ generationId: 1, timestamp: 1 });         // generation + time sort
    await thoughts.createIndex({ source: 1, conversationId: 1, timestamp: -1 }); // multi-field query with sort
    
    this.collections.set(this.COLLECTIONS.THOUGHTS, thoughts);
  }

  /**
   * Ensure connection is established
   */
  private async ensureConnected(): Promise<void> {
    if (!this.db || this.collections.size === 0) {
      await this.connect();
    }
  }

  /**
   * Get a collection by name (with type safety)
   */
  private getCollection<T extends Document = Document>(name: string): Collection<T> {
    const collection = this.collections.get(name);
    if (!collection) {
      throw new Error(`Collection ${name} not initialized`);
    }
    return collection as Collection<T>;
  }

  /**
   * Get or create a custom collection
   */
  async collection<T extends Document = Document>(name: string): Promise<Collection<T>> {
    await this.ensureConnected();
    
    if (!this.collections.has(name)) {
      const col = this.db!.collection<T>(name);
      this.collections.set(name, col);
    }
    
    return this.getCollection<T>(name);
  }

  // ==========================================================================
  // GENERIC CRUD OPERATIONS
  // ==========================================================================

  /**
   * Insert a single document into any collection
   */
  async insertOne<T extends Document>(collectionName: string, document: Omit<T, '_id'>): Promise<ObjectId> {
    await this.ensureConnected();
    const col = await this.collection<T>(collectionName);
    
    const doc = {
      ...document,
      createdAt: (document as any).createdAt || new Date(),
      updatedAt: (document as any).updatedAt || new Date(),
    };
    
    const result = await col.insertOne(doc as any);
    return result.insertedId;
  }

  /**
   * Insert multiple documents into any collection
   */
  async insertMany<T extends Document>(collectionName: string, documents: Omit<T, '_id'>[]): Promise<ObjectId[]> {
    if (documents.length === 0) return [];
    
    await this.ensureConnected();
    const col = await this.collection<T>(collectionName);
    
    const docs = documents.map(doc => ({
      ...doc,
      createdAt: (doc as any).createdAt || new Date(),
      updatedAt: (doc as any).updatedAt || new Date(),
    }));
    
    const result = await col.insertMany(docs as any);
    return Object.values(result.insertedIds);
  }

  /**
   * Find documents in any collection
   */
  async find<T extends Document>(
    collectionName: string,
    filter: Filter<T> = {},
    options?: FindOptions<T>
  ): Promise<T[]> {
    await this.ensureConnected();
    const col = await this.collection<T>(collectionName);
    return (await col.find(filter, options).toArray()) as T[];
  }

  /**
   * Find a single document in any collection
   */
  async findOne<T extends Document>(
    collectionName: string,
    filter: Filter<T>
  ): Promise<T | null> {
    await this.ensureConnected();
    const col = await this.collection<T>(collectionName);
    return (await col.findOne(filter)) as T | null;
  }

  /**
   * Update documents in any collection
   */
  async updateMany<T extends Document>(
    collectionName: string,
    filter: Filter<T>,
    update: UpdateFilter<T>
  ): Promise<number> {
    await this.ensureConnected();
    const col = await this.collection<T>(collectionName);
    
    // Add updatedAt timestamp
    const updateWithTimestamp = {
      ...update,
      $set: {
        ...((update.$set as any) || {}),
        updatedAt: new Date(),
      },
    };
    
    const result = await col.updateMany(filter, updateWithTimestamp);
    return result.modifiedCount;
  }

  /**
   * Update a single document in any collection
   */
  async updateOne<T extends Document>(
    collectionName: string,
    filter: Filter<T>,
    update: UpdateFilter<T>,
    upsert: boolean = false
  ): Promise<boolean> {
    await this.ensureConnected();
    const col = await this.collection<T>(collectionName);
    
    // Add updatedAt timestamp
    const updateWithTimestamp = {
      ...update,
      $set: {
        ...((update.$set as any) || {}),
        updatedAt: new Date(),
      },
      $setOnInsert: {
        ...((update.$setOnInsert as any) || {}),
        createdAt: new Date(),
      },
    };
    
    const result = await col.updateOne(filter, updateWithTimestamp, { upsert });
    return result.modifiedCount > 0 || (upsert && result.upsertedCount > 0);
  }

  /**
   * Delete documents from any collection
   */
  async deleteMany<T extends Document>(
    collectionName: string,
    filter: Filter<T>
  ): Promise<number> {
    await this.ensureConnected();
    const col = await this.collection<T>(collectionName);
    const result = await col.deleteMany(filter);
    return result.deletedCount;
  }

  /**
   * Delete a single document from any collection
   */
  async deleteOne<T extends Document>(
    collectionName: string,
    filter: Filter<T>
  ): Promise<boolean> {
    await this.ensureConnected();
    const col = await this.collection<T>(collectionName);
    const result = await col.deleteOne(filter);
    return result.deletedCount > 0;
  }

  /**
   * Count documents in any collection
   */
  async count<T extends Document>(
    collectionName: string,
    filter: Filter<T> = {}
  ): Promise<number> {
    await this.ensureConnected();
    const col = await this.collection<T>(collectionName);
    return await col.countDocuments(filter);
  }

  // ==========================================================================
  // MESSAGE OPERATIONS (Backward Compatible)
  // ==========================================================================

  // ==========================================================================
  // MESSAGE OPERATIONS (Backward Compatible)
  // ==========================================================================

  /**
   * Store a message in the database
   */
  async storeMessage(message: Omit<StoredMessage, '_id'>): Promise<ObjectId> {
    await this.ensureConnected();
    const messagesCol = this.getCollection<StoredMessage>(this.COLLECTIONS.MESSAGES);
    
    const result = await messagesCol.insertOne({
      ...message,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    
    // Update conversation's updatedAt timestamp
    const conversationsCol = this.getCollection<Conversation>(this.COLLECTIONS.CONVERSATIONS);
    await conversationsCol.updateOne(
      { conversationId: message.conversationId },
      { 
        $set: { updatedAt: new Date() },
        $inc: { 'metadata.messageCount': 1 },
      },
      { upsert: true }
    );
    
    return result.insertedId;
  }

  /**
   * Store multiple messages in bulk
   */
  async storeMessages(messages: Omit<StoredMessage, '_id'>[]): Promise<void> {
    if (messages.length === 0) return;
    
    await this.ensureConnected();
    const messagesCol = this.getCollection<StoredMessage>(this.COLLECTIONS.MESSAGES);
    
    await messagesCol.insertMany(messages.map(msg => ({
      ...msg,
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as any);
    
    // Update conversation timestamp
    const conversationId = messages[0].conversationId;
    const conversationsCol = this.getCollection<Conversation>(this.COLLECTIONS.CONVERSATIONS);
    await conversationsCol.updateOne(
      { conversationId },
      { 
        $set: { updatedAt: new Date() },
        $inc: { 'metadata.messageCount': messages.length },
      },
      { upsert: true }
    );
  }

  /**
   * Get messages for a conversation
   * @param limit - Maximum number of messages to retrieve (0 = all)
   * @param skip - Number of messages to skip (for pagination)
   */
  async getMessages(conversationId: string, limit: number = 0, skip: number = 0): Promise<StoredMessage[]> {
    await this.ensureConnected();
    const messagesCol = this.getCollection<StoredMessage>(this.COLLECTIONS.MESSAGES);
    
    const query = messagesCol
      .find({ conversationId })
      .sort({ timestamp: 1 })
      .skip(skip);
    
    if (limit > 0) {
      query.limit(limit);
    }
    
    return await query.toArray() as any;
  }

  /**
   * Get the last N messages for a conversation
   */
  async getLastMessages(conversationId: string, count: number): Promise<StoredMessage[]> {
    await this.ensureConnected();
    const messagesCol = this.getCollection<StoredMessage>(this.COLLECTIONS.MESSAGES);
    
    const messages = await messagesCol
      .find({ conversationId })
      .sort({ timestamp: -1 })
      .limit(count)
      .toArray();
    
    // Reverse to get chronological order
    return messages.reverse() as any;
  }

  /**
   * Get message count for a conversation
   */
  async getMessageCount(conversationId: string): Promise<number> {
    await this.ensureConnected();
    const messagesCol = this.getCollection<StoredMessage>(this.COLLECTIONS.MESSAGES);
    return await messagesCol.countDocuments({ conversationId });
  }

  // ==========================================================================
  // CONVERSATION OPERATIONS (Backward Compatible)
  // ==========================================================================

  /**
   * Create or update a conversation
   */
  async upsertConversation(conversation: Omit<Conversation, '_id'>): Promise<void> {
    await this.ensureConnected();
    const conversationsCol = this.getCollection<Conversation>(this.COLLECTIONS.CONVERSATIONS);
    
    await conversationsCol.updateOne(
      { conversationId: conversation.conversationId },
      { 
        $set: { ...conversation, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
  }

  /**
   * Update conversation title
   */
  async updateConversationTitle(conversationId: string, title: string): Promise<void> {
    await this.ensureConnected();
    const conversationsCol = this.getCollection<Conversation>(this.COLLECTIONS.CONVERSATIONS);
    
    await conversationsCol.updateOne(
      { conversationId },
      { 
        $set: { title, updatedAt: new Date() }
      }
    );
  }

  /**
   * Get a conversation by ID
   */
  async getConversation(conversationId: string): Promise<Conversation | null> {
    await this.ensureConnected();
    const conversationsCol = this.getCollection<Conversation>(this.COLLECTIONS.CONVERSATIONS);
    return await conversationsCol.findOne({ conversationId }) as any;
  }

  /**
   * Get all conversations (sorted by most recent)
   */
  async getConversations(limit: number = 50, skip: number = 0): Promise<Conversation[]> {
    await this.ensureConnected();
    const conversationsCol = this.getCollection<Conversation>(this.COLLECTIONS.CONVERSATIONS);
    
    return await conversationsCol
      .find({})
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray() as any;
  }

  /**
   * Delete a conversation and all its messages
   */
  async deleteConversation(conversationId: string): Promise<void> {
    await this.ensureConnected();
    const messagesCol = this.getCollection<StoredMessage>(this.COLLECTIONS.MESSAGES);
    const conversationsCol = this.getCollection<Conversation>(this.COLLECTIONS.CONVERSATIONS);
    
    await messagesCol.deleteMany({ conversationId });
    await conversationsCol.deleteOne({ conversationId });
  }

  // ==========================================================================
  // LOG OPERATIONS (New)
  // ==========================================================================

  /**
   * Store a log entry
   */
  async storeLog(log: Omit<StoredLog, '_id'>): Promise<ObjectId> {
    return await this.insertOne<StoredLog>(this.COLLECTIONS.LOGS, log);
  }

  /**
   * Store multiple log entries
   */
  async storeLogs(logs: Omit<StoredLog, '_id'>[]): Promise<ObjectId[]> {
    return await this.insertMany<StoredLog>(this.COLLECTIONS.LOGS, logs);
  }

  /**
   * Get logs by generation ID
   */
  async getLogsByGeneration(generationId: string, limit?: number): Promise<StoredLog[]> {
    await this.ensureConnected();
    const logsCol = this.getCollection<StoredLog>(this.COLLECTIONS.LOGS);
    
    const query = logsCol.find({ generationId }).sort({ timestamp: 1 });
    if (limit) query.limit(limit);
    
    return await query.toArray() as any;
  }

  /**
   * Get logs by conversation ID
   */
  async getLogsByConversation(conversationId: string, limit?: number): Promise<StoredLog[]> {
    await this.ensureConnected();
    const logsCol = this.getCollection<StoredLog>(this.COLLECTIONS.LOGS);
    
    const query = logsCol.find({ conversationId }).sort({ timestamp: -1 });
    if (limit) query.limit(limit);
    
    return await query.toArray() as any;
  }

  /**
   * Get logs by level
   */
  async getLogsByLevel(level: StoredLog['level'], limit?: number): Promise<StoredLog[]> {
    await this.ensureConnected();
    const logsCol = this.getCollection<StoredLog>(this.COLLECTIONS.LOGS);
    
    const query = logsCol.find({ level }).sort({ timestamp: -1 });
    if (limit) query.limit(limit);
    
    return await query.toArray() as any;
  }

  /**
   * Get logs with filters
   */
  async getLogs(filter: Partial<StoredLog> = {}, limit: number = 100, skip: number = 0): Promise<StoredLog[]> {
    return await this.find<StoredLog>(this.COLLECTIONS.LOGS, filter as Filter<StoredLog>, {
      sort: { timestamp: -1 },
      limit,
      skip,
    }) as any;
  }

  /**
   * Delete old logs (older than specified date)
   */
  async deleteOldLogs(olderThan: Date): Promise<number> {
    return await this.deleteMany<StoredLog>(this.COLLECTIONS.LOGS, {
      timestamp: { $lt: olderThan }
    } as Filter<StoredLog>);
  }

  /**
   * Get all conversations that have logs with counts and metadata
   */
  async getConversationsWithLogs(): Promise<Array<{
    conversationId: string;
    title?: string;
    lastLogTime: Date;
    logCount: number;
    generationCount: number;
  }>> {
    await this.ensureConnected();
    const logsCol = this.getCollection<StoredLog>(this.COLLECTIONS.LOGS);
    const conversationsCol = this.getCollection<Conversation>(this.COLLECTIONS.CONVERSATIONS);
    const generationsCol = this.getCollection<Generation>(this.COLLECTIONS.GENERATIONS);
    
    // Aggregate logs by conversationId
    const logAggregation = await logsCol.aggregate([
      {
        $group: {
          _id: '$conversationId',
          logCount: { $sum: 1 },
          lastLogTime: { $max: '$timestamp' }
        }
      },
      { $sort: { lastLogTime: -1 } }
    ]).toArray();
    
    // Get generation counts
    const generationAggregation = await generationsCol.aggregate([
      {
        $group: {
          _id: '$conversationId',
          generationCount: { $sum: 1 }
        }
      }
    ]).toArray();
    
    // Create maps for quick lookup
    const generationMap = new Map(
      generationAggregation.map(g => [g._id, g.generationCount])
    );
    
    // Build result with conversation titles
    const results = await Promise.all(
      logAggregation.map(async (agg: any) => {
        const conversationId = agg._id;
        
        // Try to get conversation title
        const conversation = await conversationsCol.findOne({ conversationId });
        
        return {
          conversationId,
          title: conversation?.title,
          lastLogTime: agg.lastLogTime,
          logCount: agg.logCount,
          generationCount: generationMap.get(conversationId) || 0
        };
      })
    );
    
    return results;
  }

  // ==========================================================================
  // GENERATION OPERATIONS (New)
  // ==========================================================================

  /**
   * Store a generation entry
   */
  async storeGeneration(generation: Omit<Generation, '_id'>): Promise<ObjectId> {
    return await this.insertOne<Generation>(this.COLLECTIONS.GENERATIONS, generation);
  }

  /**
   * Update generation status
   */
  async updateGenerationStatus(
    generationId: string,
    status: Generation['status'],
    metadata?: Partial<Generation>
  ): Promise<boolean> {
    return await this.updateOne<Generation>(
      this.COLLECTIONS.GENERATIONS,
      { generationId } as Filter<Generation>,
      {
        $set: {
          status,
          ...(status === 'completed' || status === 'failed' ? { endTime: new Date() } : {}),
          ...metadata,
        } as any,
      }
    );
  }

  /**
   * Get a generation by ID
   */
  async getGeneration(generationId: string): Promise<Generation | null> {
    return await this.findOne<Generation>(this.COLLECTIONS.GENERATIONS, {
      generationId
    } as Filter<Generation>) as any;
  }

  /**
   * Get generations by conversation ID
   */
  async getGenerationsByConversation(conversationId: string, limit?: number): Promise<Generation[]> {
    return await this.find<Generation>(
      this.COLLECTIONS.GENERATIONS,
      { conversationId } as Filter<Generation>,
      {
        sort: { startTime: -1 },
        limit,
      }
    ) as any;
  }

  /**
   * Get active generations (pending or streaming)
   */
  async getActiveGenerations(): Promise<Generation[]> {
    return await this.find<Generation>(
      this.COLLECTIONS.GENERATIONS,
      { status: { $in: ['pending', 'streaming'] } } as Filter<Generation>,
      { sort: { startTime: -1 } }
    ) as any;
  }

  /**
   * Delete old generations (older than specified date)
   */
  async deleteOldGenerations(olderThan: Date): Promise<number> {
    return await this.deleteMany<Generation>(this.COLLECTIONS.GENERATIONS, {
      startTime: { $lt: olderThan },
      status: { $in: ['completed', 'failed'] }
    } as Filter<Generation>);
  }

  // ==========================================================================
  // THOUGHT OPERATIONS
  // ==========================================================================

  /**
   * Store a thought/reasoning entry
   */
  async storeThought(thought: Omit<StoredThought, '_id'>): Promise<ObjectId> {
    return await this.insertOne<StoredThought>(this.COLLECTIONS.THOUGHTS, thought);
  }

  /**
   * Store multiple thoughts in bulk
   */
  async storeThoughts(thoughts: Omit<StoredThought, '_id'>[]): Promise<void> {
    if (thoughts.length === 0) return;
    await this.insertMany<StoredThought>(this.COLLECTIONS.THOUGHTS, thoughts);
  }

  /**
   * Get thought by ID
   */
  async getThought(thoughtId: string): Promise<StoredThought | null> {
    return await this.findOne<StoredThought>(this.COLLECTIONS.THOUGHTS, {
      thoughtId
    } as Filter<StoredThought>) as any;
  }

  /**
   * Get thoughts for a specific message
   */
  async getThoughtsByMessage(messageId: string): Promise<StoredThought[]> {
    return await this.find<StoredThought>(
      this.COLLECTIONS.THOUGHTS,
      { messageId } as Filter<StoredThought>,
      { sort: { timestamp: 1 } }
    ) as any;
  }

  /**
   * Get thoughts for a conversation
   */
  async getThoughtsByConversation(conversationId: string, limit?: number): Promise<StoredThought[]> {
    return await this.find<StoredThought>(
      this.COLLECTIONS.THOUGHTS,
      { conversationId } as Filter<StoredThought>,
      {
        sort: { timestamp: -1 },
        limit,
      }
    ) as any;
  }

  /**
   * Get thoughts for a generation
   */
  async getThoughtsByGeneration(generationId: string): Promise<StoredThought[]> {
    return await this.find<StoredThought>(
      this.COLLECTIONS.THOUGHTS,
      { generationId } as Filter<StoredThought>,
      { sort: { timestamp: 1 } }
    ) as any;
  }

  /**
   * Get thoughts by source (chat, router, toolPicker)
   */
  async getThoughtsBySource(source: string, conversationId?: string, limit?: number): Promise<StoredThought[]> {
    const filter: any = { source };
    if (conversationId) {
      filter.conversationId = conversationId;
    }
    return await this.find<StoredThought>(
      this.COLLECTIONS.THOUGHTS,
      filter as Filter<StoredThought>,
      {
        sort: { timestamp: -1 },
        limit,
      }
    ) as any;
  }

  /**
   * Delete old thoughts (older than specified date)
   */
  async deleteOldThoughts(olderThan: Date): Promise<number> {
    return await this.deleteMany<StoredThought>(this.COLLECTIONS.THOUGHTS, {
      timestamp: { $lt: olderThan }
    } as Filter<StoredThought>);
  }

  // ==========================================================================
  // CONNECTION MANAGEMENT
  // ==========================================================================

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.collections.clear();
      this.connectionPromise = null;
      console.log('[Database] Closed MongoDB connection');
    }
  }
}

// ============================================================================
// SINGLETON & EXPORTS
// ============================================================================

// Singleton instance
let dbInstance: DatabaseManager | null = null;

/**
 * Get the singleton database instance
 * @param mongoUrl - MongoDB connection URL (default: from env or localhost)
 * @param dbName - Database name (default: from env or 'redbtn_ai')
 */
export function getDatabase(mongoUrl?: string, dbName?: string): DatabaseManager {
  if (!dbInstance) {
    // Support both MONGODB_URI and MONGODB_URL
    const envUri = process.env.MONGODB_URI || process.env.MONGODB_URL || 'mongodb://localhost:27017';
    const url = mongoUrl || envUri;
    
    // Try to extract database name from URI if present
    let name = dbName;
    if (!name) {
      // Parse database name from URI like mongodb://user:pass@host:port/dbname
      const dbMatch = url.match(/\/([^/?]+)(\?|$)/);
      if (dbMatch && dbMatch[1]) {
        name = dbMatch[1];
      } else {
        name = process.env.MONGODB_NAME || 'redbtn_ai';
      }
    }
    
    dbInstance = new DatabaseManager(url, name);
  }
  return dbInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetDatabase(): void {
  dbInstance = null;
}

export { DatabaseManager };
