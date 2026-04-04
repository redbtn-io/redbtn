"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseManager = void 0;
exports.getDatabase = getDatabase;
exports.resetDatabase = resetDatabase;
const mongodb_1 = require("mongodb");
// ============================================================================
// DATABASE MANAGER CLASS
// ============================================================================
/**
 * Universal database manager for MongoDB operations
 * Supports messages, conversations, logs, generations, and generic collections
 */
class DatabaseManager {
    constructor(mongoUrl = 'mongodb://localhost:27017', dbName = 'redbtn_ai') {
        this.mongoUrl = mongoUrl;
        this.dbName = dbName;
        this.client = null;
        this.db = null;
        this.collections = new Map();
        this.connectionPromise = null;
        // Pre-defined collection names
        this.COLLECTIONS = {
            MESSAGES: 'messages',
            CONVERSATIONS: 'conversations',
            LOGS: 'logs',
            GENERATIONS: 'generations',
            THOUGHTS: 'thoughts',
        };
    }
    // ==========================================================================
    // CONNECTION MANAGEMENT
    // ==========================================================================
    // ==========================================================================
    // CONNECTION MANAGEMENT
    // ==========================================================================
    /**
     * Connect to MongoDB and initialize collections
     */
    connect() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.connectionPromise) {
                return this.connectionPromise;
            }
            this.connectionPromise = (() => __awaiter(this, void 0, void 0, function* () {
                try {
                    console.log('[Database] Connecting to MongoDB...');
                    // Connection options
                    const options = {
                        authMechanism: undefined,
                        authSource: 'admin',
                    };
                    // If URL contains username/password, set auth source
                    if (this.mongoUrl.includes('@')) {
                        options.authSource = 'admin';
                    }
                    this.client = new mongodb_1.MongoClient(this.mongoUrl, {
                        serverSelectionTimeoutMS: 5000,
                        connectTimeoutMS: 10000,
                    });
                    yield this.client.connect();
                    // Test the connection
                    yield this.client.db('admin').admin().ping();
                    this.db = this.client.db(this.dbName);
                    // Initialize core collections
                    yield this.initializeCollections();
                    console.log('[Database] Connected to MongoDB successfully');
                }
                catch (error) {
                    console.error('[Database] Failed to connect to MongoDB:', error);
                    console.error('[Database] Make sure MongoDB is running and authentication is configured correctly');
                    console.error('[Database] Current connection string:', this.mongoUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@'));
                    this.connectionPromise = null;
                    throw error;
                }
            }))();
            return this.connectionPromise;
        });
    }
    /**
     * Initialize collections with indexes
     */
    initializeCollections() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.db)
                throw new Error('Database not connected');
            // Messages collection
            const messages = this.db.collection(this.COLLECTIONS.MESSAGES);
            yield messages.createIndex({ conversationId: 1, timestamp: 1 });
            yield messages.createIndex({ timestamp: -1 });
            // Try to create unique index on messageId, but don't fail if it exists or has duplicates
            try {
                yield messages.createIndex({ messageId: 1 }, { unique: true, sparse: true });
            }
            catch (error) {
                if (error.code === 11000) {
                    console.warn('[Database] ⚠️ Duplicate messageId values exist. Run migration to fix: npm run db:fix-messageids');
                }
                else if (error.codeName !== 'IndexOptionsConflict' && error.codeName !== 'IndexAlreadyExists') {
                    console.warn('[Database] ⚠️ Failed to create messageId index:', error.message);
                }
            }
            this.collections.set(this.COLLECTIONS.MESSAGES, messages);
            // Conversations collection
            const conversations = this.db.collection(this.COLLECTIONS.CONVERSATIONS);
            yield conversations.createIndex({ conversationId: 1 }, { unique: true });
            yield conversations.createIndex({ updatedAt: -1 });
            yield conversations.createIndex({ userId: 1 });
            this.collections.set(this.COLLECTIONS.CONVERSATIONS, conversations);
            // Logs collection with 6-month TTL
            const logs = this.db.collection(this.COLLECTIONS.LOGS);
            yield logs.createIndex({ timestamp: -1 });
            yield logs.createIndex({ generationId: 1 });
            yield logs.createIndex({ conversationId: 1 });
            yield logs.createIndex({ level: 1 });
            yield logs.createIndex({ category: 1 });
            yield logs.createIndex({ logId: 1 }, { unique: true });
            // TTL index: automatically delete logs after 6 months (15552000 seconds)
            yield logs.createIndex({ timestamp: 1 }, { expireAfterSeconds: 15552000 });
            this.collections.set(this.COLLECTIONS.LOGS, logs);
            // Generations collection
            const generations = this.db.collection(this.COLLECTIONS.GENERATIONS);
            yield generations.createIndex({ generationId: 1 }, { unique: true });
            yield generations.createIndex({ conversationId: 1 });
            yield generations.createIndex({ status: 1 });
            yield generations.createIndex({ startTime: -1 });
            yield generations.createIndex({ nodeId: 1 });
            this.collections.set(this.COLLECTIONS.GENERATIONS, generations);
            // Thoughts collection (stores thinking/reasoning separately from messages)
            const thoughts = this.db.collection(this.COLLECTIONS.THOUGHTS);
            yield thoughts.createIndex({ thoughtId: 1 }, { unique: true });
            // Single field indexes for basic queries
            yield thoughts.createIndex({ conversationId: 1 });
            yield thoughts.createIndex({ messageId: 1 });
            yield thoughts.createIndex({ generationId: 1 });
            yield thoughts.createIndex({ timestamp: -1 });
            yield thoughts.createIndex({ source: 1 });
            // Composite indexes for optimized multi-field queries
            yield thoughts.createIndex({ messageId: 1, timestamp: -1 }); // messageId + time sort
            yield thoughts.createIndex({ conversationId: 1, timestamp: -1 }); // conversation + time sort
            yield thoughts.createIndex({ generationId: 1, timestamp: 1 }); // generation + time sort
            yield thoughts.createIndex({ source: 1, conversationId: 1, timestamp: -1 }); // multi-field query with sort
            this.collections.set(this.COLLECTIONS.THOUGHTS, thoughts);
        });
    }
    /**
     * Ensure connection is established
     */
    ensureConnected() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.db || this.collections.size === 0) {
                yield this.connect();
            }
        });
    }
    /**
     * Get a collection by name (with type safety)
     */
    getCollection(name) {
        const collection = this.collections.get(name);
        if (!collection) {
            throw new Error(`Collection ${name} not initialized`);
        }
        return collection;
    }
    /**
     * Get or create a custom collection
     */
    collection(name) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            if (!this.collections.has(name)) {
                const col = this.db.collection(name);
                this.collections.set(name, col);
            }
            return this.getCollection(name);
        });
    }
    // ==========================================================================
    // GENERIC CRUD OPERATIONS
    // ==========================================================================
    /**
     * Insert a single document into any collection
     */
    insertOne(collectionName, document) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const col = yield this.collection(collectionName);
            const doc = Object.assign(Object.assign({}, document), { createdAt: document.createdAt || new Date(), updatedAt: document.updatedAt || new Date() });
            const result = yield col.insertOne(doc);
            return result.insertedId;
        });
    }
    /**
     * Insert multiple documents into any collection
     */
    insertMany(collectionName, documents) {
        return __awaiter(this, void 0, void 0, function* () {
            if (documents.length === 0)
                return [];
            yield this.ensureConnected();
            const col = yield this.collection(collectionName);
            const docs = documents.map(doc => (Object.assign(Object.assign({}, doc), { createdAt: doc.createdAt || new Date(), updatedAt: doc.updatedAt || new Date() })));
            const result = yield col.insertMany(docs);
            return Object.values(result.insertedIds);
        });
    }
    /**
     * Find documents in any collection
     */
    find(collectionName_1) {
        return __awaiter(this, arguments, void 0, function* (collectionName, filter = {}, options) {
            yield this.ensureConnected();
            const col = yield this.collection(collectionName);
            return (yield col.find(filter, options).toArray());
        });
    }
    /**
     * Find a single document in any collection
     */
    findOne(collectionName, filter) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const col = yield this.collection(collectionName);
            return (yield col.findOne(filter));
        });
    }
    /**
     * Update documents in any collection
     */
    updateMany(collectionName, filter, update) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const col = yield this.collection(collectionName);
            // Add updatedAt timestamp
            const updateWithTimestamp = Object.assign(Object.assign({}, update), { $set: Object.assign(Object.assign({}, (update.$set || {})), { updatedAt: new Date() }) });
            const result = yield col.updateMany(filter, updateWithTimestamp);
            return result.modifiedCount;
        });
    }
    /**
     * Update a single document in any collection
     */
    updateOne(collectionName_1, filter_1, update_1) {
        return __awaiter(this, arguments, void 0, function* (collectionName, filter, update, upsert = false) {
            yield this.ensureConnected();
            const col = yield this.collection(collectionName);
            // Add updatedAt timestamp
            const updateWithTimestamp = Object.assign(Object.assign({}, update), { $set: Object.assign(Object.assign({}, (update.$set || {})), { updatedAt: new Date() }), $setOnInsert: Object.assign(Object.assign({}, (update.$setOnInsert || {})), { createdAt: new Date() }) });
            const result = yield col.updateOne(filter, updateWithTimestamp, { upsert });
            return result.modifiedCount > 0 || (upsert && result.upsertedCount > 0);
        });
    }
    /**
     * Delete documents from any collection
     */
    deleteMany(collectionName, filter) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const col = yield this.collection(collectionName);
            const result = yield col.deleteMany(filter);
            return result.deletedCount;
        });
    }
    /**
     * Delete a single document from any collection
     */
    deleteOne(collectionName, filter) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const col = yield this.collection(collectionName);
            const result = yield col.deleteOne(filter);
            return result.deletedCount > 0;
        });
    }
    /**
     * Count documents in any collection
     */
    count(collectionName_1) {
        return __awaiter(this, arguments, void 0, function* (collectionName, filter = {}) {
            yield this.ensureConnected();
            const col = yield this.collection(collectionName);
            return yield col.countDocuments(filter);
        });
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
    storeMessage(message) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const messagesCol = this.getCollection(this.COLLECTIONS.MESSAGES);
            console.log(`[Database] storeMessage called - messageId:${message.messageId}, role:${message.role}`);
            try {
                const result = yield messagesCol.insertOne(Object.assign(Object.assign({}, message), { createdAt: new Date(), updatedAt: new Date() }));
                console.log(`[Database] Message stored successfully - messageId:${message.messageId}, _id:${result.insertedId}`);
                // Update conversation's updatedAt timestamp
                const conversationsCol = this.getCollection(this.COLLECTIONS.CONVERSATIONS);
                yield conversationsCol.updateOne({ conversationId: message.conversationId }, {
                    $set: { updatedAt: new Date() },
                    $inc: { 'metadata.messageCount': 1 },
                }, { upsert: true });
                return result.insertedId;
            }
            catch (error) {
                // If duplicate key error (code 11000), message already exists - silently ignore
                if (error.code === 11000) {
                    console.log(`[Database] Message ${message.messageId} already exists, skipping duplicate`);
                    // Return a dummy ObjectId since we don't have the real one
                    return new mongodb_1.ObjectId();
                }
                throw error;
            }
        });
    }
    /**
     * Store multiple messages in bulk
     */
    storeMessages(messages) {
        return __awaiter(this, void 0, void 0, function* () {
            if (messages.length === 0)
                return;
            yield this.ensureConnected();
            const messagesCol = this.getCollection(this.COLLECTIONS.MESSAGES);
            yield messagesCol.insertMany(messages.map(msg => (Object.assign(Object.assign({}, msg), { createdAt: new Date(), updatedAt: new Date() }))));
            // Update conversation timestamp
            const conversationId = messages[0].conversationId;
            const conversationsCol = this.getCollection(this.COLLECTIONS.CONVERSATIONS);
            yield conversationsCol.updateOne({ conversationId }, {
                $set: { updatedAt: new Date() },
                $inc: { 'metadata.messageCount': messages.length },
            }, { upsert: true });
        });
    }
    /**
     * Get messages for a conversation
     * @param limit - Maximum number of messages to retrieve (0 = all)
     * @param skip - Number of messages to skip (for pagination)
     */
    getMessages(conversationId_1) {
        return __awaiter(this, arguments, void 0, function* (conversationId, limit = 0, skip = 0) {
            yield this.ensureConnected();
            const messagesCol = this.getCollection(this.COLLECTIONS.MESSAGES);
            const query = messagesCol
                .find({ conversationId })
                .sort({ timestamp: 1 })
                .skip(skip);
            if (limit > 0) {
                query.limit(limit);
            }
            return yield query.toArray();
        });
    }
    /**
     * Get the last N messages for a conversation
     */
    getLastMessages(conversationId, count) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const messagesCol = this.getCollection(this.COLLECTIONS.MESSAGES);
            const messages = yield messagesCol
                .find({ conversationId })
                .sort({ timestamp: -1 })
                .limit(count)
                .toArray();
            // Reverse to get chronological order
            return messages.reverse();
        });
    }
    /**
     * Get message count for a conversation
     */
    getMessageCount(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const messagesCol = this.getCollection(this.COLLECTIONS.MESSAGES);
            return yield messagesCol.countDocuments({ conversationId });
        });
    }
    // ==========================================================================
    // CONVERSATION OPERATIONS (Backward Compatible)
    // ==========================================================================
    /**
     * Create or update a conversation
     */
    upsertConversation(conversation) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const conversationsCol = this.getCollection(this.COLLECTIONS.CONVERSATIONS);
            yield conversationsCol.updateOne({ conversationId: conversation.conversationId }, {
                $set: Object.assign(Object.assign({}, conversation), { updatedAt: new Date() }),
                $setOnInsert: { createdAt: new Date() }
            }, { upsert: true });
        });
    }
    /**
     * Update conversation title
     */
    updateConversationTitle(conversationId, title) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const conversationsCol = this.getCollection(this.COLLECTIONS.CONVERSATIONS);
            yield conversationsCol.updateOne({ conversationId }, {
                $set: { title, updatedAt: new Date() }
            });
        });
    }
    /**
     * Get a conversation by ID
     */
    getConversation(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const conversationsCol = this.getCollection(this.COLLECTIONS.CONVERSATIONS);
            return yield conversationsCol.findOne({ conversationId });
        });
    }
    /**
     * Get all conversations (sorted by most recent)
     */
    getConversations() {
        return __awaiter(this, arguments, void 0, function* (limit = 50, skip = 0) {
            yield this.ensureConnected();
            const conversationsCol = this.getCollection(this.COLLECTIONS.CONVERSATIONS);
            return yield conversationsCol
                .find({})
                .sort({ updatedAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();
        });
    }
    /**
     * Delete a conversation and all its messages
     */
    deleteConversation(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const messagesCol = this.getCollection(this.COLLECTIONS.MESSAGES);
            const conversationsCol = this.getCollection(this.COLLECTIONS.CONVERSATIONS);
            yield messagesCol.deleteMany({ conversationId });
            yield conversationsCol.deleteOne({ conversationId });
        });
    }
    // ==========================================================================
    // LOG OPERATIONS (New)
    // ==========================================================================
    /**
     * Store a log entry
     */
    storeLog(log) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.insertOne(this.COLLECTIONS.LOGS, log);
        });
    }
    /**
     * Store multiple log entries
     */
    storeLogs(logs) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.insertMany(this.COLLECTIONS.LOGS, logs);
        });
    }
    /**
     * Get logs by generation ID
     */
    getLogsByGeneration(generationId, limit) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const logsCol = this.getCollection(this.COLLECTIONS.LOGS);
            const query = logsCol.find({ generationId }).sort({ timestamp: 1 });
            if (limit)
                query.limit(limit);
            return yield query.toArray();
        });
    }
    /**
     * Get logs by conversation ID
     */
    getLogsByConversation(conversationId, limit) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const logsCol = this.getCollection(this.COLLECTIONS.LOGS);
            const query = logsCol.find({ conversationId }).sort({ timestamp: -1 });
            if (limit)
                query.limit(limit);
            return yield query.toArray();
        });
    }
    /**
     * Get logs by level
     */
    getLogsByLevel(level, limit) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const logsCol = this.getCollection(this.COLLECTIONS.LOGS);
            const query = logsCol.find({ level }).sort({ timestamp: -1 });
            if (limit)
                query.limit(limit);
            return yield query.toArray();
        });
    }
    /**
     * Get logs with filters
     */
    getLogs() {
        return __awaiter(this, arguments, void 0, function* (filter = {}, limit = 100, skip = 0) {
            return yield this.find(this.COLLECTIONS.LOGS, filter, {
                sort: { timestamp: -1 },
                limit,
                skip,
            });
        });
    }
    /**
     * Delete old logs (older than specified date)
     */
    deleteOldLogs(olderThan) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.deleteMany(this.COLLECTIONS.LOGS, {
                timestamp: { $lt: olderThan }
            });
        });
    }
    /**
     * Get all conversations that have logs with counts and metadata
     */
    getConversationsWithLogs() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.ensureConnected();
            const logsCol = this.getCollection(this.COLLECTIONS.LOGS);
            const conversationsCol = this.getCollection(this.COLLECTIONS.CONVERSATIONS);
            const generationsCol = this.getCollection(this.COLLECTIONS.GENERATIONS);
            // Aggregate logs by conversationId
            const logAggregation = yield logsCol.aggregate([
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
            const generationAggregation = yield generationsCol.aggregate([
                {
                    $group: {
                        _id: '$conversationId',
                        generationCount: { $sum: 1 }
                    }
                }
            ]).toArray();
            // Create maps for quick lookup
            const generationMap = new Map(generationAggregation.map(g => [g._id, g.generationCount]));
            // Build result with conversation titles
            const results = yield Promise.all(logAggregation.map((agg) => __awaiter(this, void 0, void 0, function* () {
                const conversationId = agg._id;
                // Try to get conversation title
                const conversation = yield conversationsCol.findOne({ conversationId });
                return {
                    conversationId,
                    title: conversation === null || conversation === void 0 ? void 0 : conversation.title,
                    lastLogTime: agg.lastLogTime,
                    logCount: agg.logCount,
                    generationCount: generationMap.get(conversationId) || 0
                };
            })));
            return results;
        });
    }
    // ==========================================================================
    // GENERATION OPERATIONS (New)
    // ==========================================================================
    /**
     * Store a generation entry
     */
    storeGeneration(generation) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.insertOne(this.COLLECTIONS.GENERATIONS, generation);
        });
    }
    /**
     * Update generation status
     */
    updateGenerationStatus(generationId, status, metadata) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.updateOne(this.COLLECTIONS.GENERATIONS, { generationId }, {
                $set: Object.assign(Object.assign({ status }, (status === 'completed' || status === 'failed' ? { endTime: new Date() } : {})), metadata),
            });
        });
    }
    /**
     * Get a generation by ID
     */
    getGeneration(generationId) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.findOne(this.COLLECTIONS.GENERATIONS, {
                generationId
            });
        });
    }
    /**
     * Get generations by conversation ID
     */
    getGenerationsByConversation(conversationId, limit) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.find(this.COLLECTIONS.GENERATIONS, { conversationId }, {
                sort: { startTime: -1 },
                limit,
            });
        });
    }
    /**
     * Get active generations (pending or streaming)
     */
    getActiveGenerations() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.find(this.COLLECTIONS.GENERATIONS, { status: { $in: ['pending', 'streaming'] } }, { sort: { startTime: -1 } });
        });
    }
    /**
     * Delete old generations (older than specified date)
     */
    deleteOldGenerations(olderThan) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.deleteMany(this.COLLECTIONS.GENERATIONS, {
                startTime: { $lt: olderThan },
                status: { $in: ['completed', 'failed'] }
            });
        });
    }
    // ==========================================================================
    // THOUGHT OPERATIONS
    // ==========================================================================
    /**
     * Store a thought/reasoning entry
     */
    storeThought(thought) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.insertOne(this.COLLECTIONS.THOUGHTS, thought);
        });
    }
    /**
     * Store multiple thoughts in bulk
     */
    storeThoughts(thoughts) {
        return __awaiter(this, void 0, void 0, function* () {
            if (thoughts.length === 0)
                return;
            yield this.insertMany(this.COLLECTIONS.THOUGHTS, thoughts);
        });
    }
    /**
     * Get thought by ID
     */
    getThought(thoughtId) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.findOne(this.COLLECTIONS.THOUGHTS, {
                thoughtId
            });
        });
    }
    /**
     * Get thoughts for a specific message
     */
    getThoughtsByMessage(messageId) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.find(this.COLLECTIONS.THOUGHTS, { messageId }, { sort: { timestamp: 1 } });
        });
    }
    /**
     * Get thoughts for a conversation
     */
    getThoughtsByConversation(conversationId, limit) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.find(this.COLLECTIONS.THOUGHTS, { conversationId }, {
                sort: { timestamp: -1 },
                limit,
            });
        });
    }
    /**
     * Get thoughts for a generation
     */
    getThoughtsByGeneration(generationId) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.find(this.COLLECTIONS.THOUGHTS, { generationId }, { sort: { timestamp: 1 } });
        });
    }
    /**
     * Get thoughts by source (chat, router, toolPicker)
     */
    getThoughtsBySource(source, conversationId, limit) {
        return __awaiter(this, void 0, void 0, function* () {
            const filter = { source };
            if (conversationId) {
                filter.conversationId = conversationId;
            }
            return yield this.find(this.COLLECTIONS.THOUGHTS, filter, {
                sort: { timestamp: -1 },
                limit,
            });
        });
    }
    /**
     * Delete old thoughts (older than specified date)
     */
    deleteOldThoughts(olderThan) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.deleteMany(this.COLLECTIONS.THOUGHTS, {
                timestamp: { $lt: olderThan }
            });
        });
    }
    // ==========================================================================
    // CONNECTION MANAGEMENT
    // ==========================================================================
    /**
     * Close database connection
     */
    close() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.client) {
                yield this.client.close();
                this.client = null;
                this.db = null;
                this.collections.clear();
                this.connectionPromise = null;
                console.log('[Database] Closed MongoDB connection');
            }
        });
    }
}
exports.DatabaseManager = DatabaseManager;
// ============================================================================
// SINGLETON & EXPORTS
// ============================================================================
// Singleton instance
let dbInstance = null;
/**
 * Get the singleton database instance
 * @param mongoUrl - MongoDB connection URL (default: from env or localhost)
 * @param dbName - Database name (default: from env or 'redbtn_ai')
 */
function getDatabase(mongoUrl, dbName) {
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
            }
            else {
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
function resetDatabase() {
    dbInstance = null;
}
