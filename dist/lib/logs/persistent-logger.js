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
exports.PersistentLogger = void 0;
const logger_1 = require("./logger");
const database_1 = require("../memory/database");
/**
 * Enhanced Logger with MongoDB persistence
 *
 * Features:
 * - All original Logger functionality (Redis pub/sub, 30-day TTL)
 * - Async batch writes to MongoDB (5-second intervals)
 * - 6-month TTL in MongoDB (automatic cleanup)
 * - Graceful error handling (Redis always succeeds even if MongoDB fails)
 * - Automatic flush on shutdown
 */
class PersistentLogger extends logger_1.Logger {
    constructor(redis, nodeId = 'default') {
        super(redis);
        this.db = (0, database_1.getDatabase)();
        this.logQueue = [];
        this.generationQueue = new Map();
        this.flushInterval = null;
        this.FLUSH_INTERVAL_MS = 5000; // 5 seconds
        this.MAX_BATCH_SIZE = 100;
        this.nodeId = nodeId;
        this.startFlushInterval();
    }
    /**
     * Start the automatic flush interval
     */
    startFlushInterval() {
        this.flushInterval = setInterval(() => __awaiter(this, void 0, void 0, function* () {
            yield this.flushQueues();
        }), this.FLUSH_INTERVAL_MS);
    }
    /**
     * Flush queued logs and generations to MongoDB
     */
    flushQueues() {
        return __awaiter(this, void 0, void 0, function* () {
            // Flush logs
            if (this.logQueue.length > 0) {
                const batch = this.logQueue.splice(0, this.logQueue.length);
                try {
                    yield this.db.storeLogs(batch);
                    console.log(`[PersistentLogger] Persisted ${batch.length} logs to MongoDB`);
                }
                catch (error) {
                    console.error('[PersistentLogger] Failed to persist logs to MongoDB:', error);
                    // Don't re-queue to avoid infinite growth on persistent failures
                }
            }
            // Flush generations
            if (this.generationQueue.size > 0) {
                const generations = Array.from(this.generationQueue.values());
                this.generationQueue.clear();
                for (const gen of generations) {
                    try {
                        // Check if generation exists, update if it does, insert if not
                        const existing = yield this.db.getGeneration(gen.generationId);
                        if (existing) {
                            yield this.db.updateGenerationStatus(gen.generationId, gen.status, {
                                endTime: gen.endTime,
                                duration: gen.duration,
                                error: gen.error,
                            });
                        }
                        else {
                            yield this.db.storeGeneration(gen);
                        }
                    }
                    catch (error) {
                        console.error(`[PersistentLogger] Failed to persist generation ${gen.generationId}:`, error);
                    }
                }
                if (generations.length > 0) {
                    console.log(`[PersistentLogger] Persisted ${generations.length} generation(s) to MongoDB`);
                }
            }
        });
    }
    /**
     * Convert LogEntry to StoredLog format
     */
    convertToStoredLog(logEntry) {
        return {
            logId: logEntry.id,
            generationId: logEntry.generationId,
            conversationId: logEntry.conversationId,
            level: this.mapLogLevel(logEntry.level),
            category: logEntry.category,
            message: logEntry.message,
            timestamp: new Date(logEntry.timestamp),
            nodeId: this.nodeId,
            metadata: logEntry.metadata,
        };
    }
    /**
     * Map log levels to StoredLog format
     */
    mapLogLevel(level) {
        const mapped = {
            'info': 'info',
            'warn': 'warn',
            'error': 'error',
            'debug': 'debug',
            'trace': 'trace',
            // Fallback
            'log': 'info',
        };
        return mapped[level] || 'info';
    }
    /**
     * Override log method to also queue for MongoDB persistence
     */
    log(params) {
        const _super = Object.create(null, {
            log: { get: () => super.log }
        });
        return __awaiter(this, void 0, void 0, function* () {
            // Call parent method (writes to Redis, publishes to pub/sub)
            yield _super.log.call(this, params);
            // Queue for MongoDB persistence
            try {
                const storedLog = this.convertToStoredLog({
                    id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                    timestamp: Date.now(),
                    level: params.level,
                    category: params.category,
                    message: params.message,
                    generationId: params.generationId,
                    conversationId: params.conversationId,
                    metadata: params.metadata,
                });
                this.logQueue.push(storedLog);
                // Flush immediately if queue is too large
                if (this.logQueue.length >= this.MAX_BATCH_SIZE) {
                    yield this.flushQueues();
                }
            }
            catch (error) {
                console.error('[PersistentLogger] Failed to queue log for MongoDB:', error);
                // Don't throw - Redis write already succeeded
            }
        });
    }
    /**
     * Override startGeneration to also track in MongoDB
     */
    startGeneration(conversationId, generationId) {
        const _super = Object.create(null, {
            startGeneration: { get: () => super.startGeneration }
        });
        return __awaiter(this, void 0, void 0, function* () {
            const genId = yield _super.startGeneration.call(this, conversationId, generationId);
            if (genId) {
                try {
                    // Queue generation for MongoDB
                    const dbGeneration = {
                        generationId: genId,
                        conversationId,
                        status: 'pending',
                        nodeId: this.nodeId,
                        startTime: new Date(),
                    };
                    this.generationQueue.set(genId, dbGeneration);
                }
                catch (error) {
                    console.error('[PersistentLogger] Failed to queue generation for MongoDB:', error);
                    // Don't throw - Redis write already succeeded
                }
            }
            return genId;
        });
    }
    /**
     * Override completeGeneration to track in MongoDB
     */
    completeGeneration(generationId, data) {
        const _super = Object.create(null, {
            completeGeneration: { get: () => super.completeGeneration }
        });
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            yield _super.completeGeneration.call(this, generationId, data);
            try {
                const existing = this.generationQueue.get(generationId);
                if (existing) {
                    existing.status = 'completed';
                    existing.endTime = new Date();
                    existing.duration = existing.endTime.getTime() - existing.startTime.getTime();
                    if (data.tokens) {
                        existing.tokensUsed = data.tokens.total || 0;
                    }
                    existing.model = data.model;
                }
                else {
                    // Create completed entry
                    this.generationQueue.set(generationId, {
                        generationId,
                        conversationId: '',
                        status: 'completed',
                        nodeId: this.nodeId,
                        model: data.model,
                        startTime: new Date(),
                        endTime: new Date(),
                        duration: 0,
                        tokensUsed: ((_a = data.tokens) === null || _a === void 0 ? void 0 : _a.total) || 0,
                    });
                }
                // Flush immediately on completion
                yield this.flushQueues();
            }
            catch (error) {
                console.error('[PersistentLogger] Failed to complete generation in MongoDB:', error);
            }
        });
    }
    /**
     * Override failGeneration to track in MongoDB
     */
    failGeneration(generationId, error) {
        const _super = Object.create(null, {
            failGeneration: { get: () => super.failGeneration }
        });
        return __awaiter(this, void 0, void 0, function* () {
            yield _super.failGeneration.call(this, generationId, error);
            try {
                const existing = this.generationQueue.get(generationId);
                if (existing) {
                    existing.status = 'failed';
                    existing.endTime = new Date();
                    existing.duration = existing.endTime.getTime() - existing.startTime.getTime();
                    existing.error = error;
                }
                else {
                    // Create failed entry
                    this.generationQueue.set(generationId, {
                        generationId,
                        conversationId: '',
                        status: 'failed',
                        nodeId: this.nodeId,
                        startTime: new Date(),
                        endTime: new Date(),
                        duration: 0,
                        error,
                    });
                }
                // Flush immediately on failure
                yield this.flushQueues();
            }
            catch (error) {
                console.error('[PersistentLogger] Failed to mark generation as failed in MongoDB:', error);
            }
        });
    }
    /**
     * Get all conversations that have logs with counts and metadata
     */
    getConversationsWithLogs() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                return yield this.db.getConversationsWithLogs();
            }
            catch (error) {
                console.error('[PersistentLogger] Failed to get conversations with logs:', error);
                return [];
            }
        });
    }
    /**
     * Shutdown the logger and flush all pending writes
     */
    shutdown() {
        return __awaiter(this, void 0, void 0, function* () {
            console.log('[PersistentLogger] Shutting down...');
            // Stop the flush interval
            if (this.flushInterval) {
                clearInterval(this.flushInterval);
                this.flushInterval = null;
            }
            // Flush any remaining queued data
            yield this.flushQueues();
            // Close database connection
            yield this.db.close();
            console.log('[PersistentLogger] Shutdown complete');
        });
    }
}
exports.PersistentLogger = PersistentLogger;
