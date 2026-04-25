import { MongoClient, Db, Collection, ObjectId, Document, Filter, UpdateFilter, FindOptions } from 'mongodb';
// FindOptions is not generic in MongoDB driver v7+, so we use a plain type alias
type FindOptionsCompat = FindOptions;

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

// ============================================================================
// DATABASE MANAGER CLASS
// ============================================================================

/**
 * Universal database manager for MongoDB operations.
 * Provides generic CRUD against arbitrary collections via `collection<T>(name)`.
 * Structured engine logging lives in `@redbtn/redlog` (collection: `redlogs`),
 * and conversation/message storage is handled by the webapp-managed
 * `user_conversations` collection.
 */
class DatabaseManager {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collections: Map<string, Collection<any>> = new Map();
  private connectionPromise: Promise<void> | null = null;

  // No pre-defined collections. Messages and conversations live in
  // the webapp-managed `user_conversations` collection (the engine
  // writes into its embedded `messages[]` via MemoryManager and
  // ConversationPublisher). Structured logs are handled by
  // `@redbtn/redlog` against the `redlogs` collection. Anything else
  // can be opened on-demand via `db.collection<T>(name)`.

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
   * Initialize collections with indexes.
   *
   * No collections are pre-initialized. Use `db.collection<T>(name)` to
   * open arbitrary collections on demand.
   */
  private async initializeCollections(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');
    // intentionally empty
  }

  /**
   * Ensure connection is established
   */
  private async ensureConnected(): Promise<void> {
    if (!this.db) {
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
    options?: FindOptionsCompat
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
