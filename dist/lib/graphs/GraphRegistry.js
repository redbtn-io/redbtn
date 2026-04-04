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
exports.GraphRegistry = exports.GraphAccessDeniedError = exports.GraphNotFoundError = void 0;
/**
 * GraphRegistry
 *
 * Phase 1: Dynamic Graph System
 * Manages dynamic loading, caching, and compilation of graph configurations.
 * Mirrors NeuronRegistry architecture pattern.
 *
 * Key Features:
 * - LRU cache for compiled graphs (5min TTL)
 * - Per-user graph compilation
 * - Tier-based access control
 * - System default graphs + user custom graphs
 * - JIT compilation from MongoDB configs
 */
const lru_cache_1 = require("lru-cache");
const database_1 = require("../memory/database");
const Graph_1 = require("../models/Graph");
const compiler_1 = require("./compiler");
class GraphNotFoundError extends Error {
    constructor(message) { super(message); this.name = 'GraphNotFoundError'; }
}
exports.GraphNotFoundError = GraphNotFoundError;
class GraphAccessDeniedError extends Error {
    constructor(message) { super(message); this.name = 'GraphAccessDeniedError'; }
}
exports.GraphAccessDeniedError = GraphAccessDeniedError;
class GraphRegistry {
    constructor(config) {
        this.config = config;
        this.db = (0, database_1.getDatabase)(config.databaseUrl);
        this.compiledCache = new lru_cache_1.LRUCache({
            max: 50,
            ttl: 5 * 60 * 1000,
        });
        this.configCache = new lru_cache_1.LRUCache({
            max: 100,
            ttl: 5 * 60 * 1000,
        });
    }
    initialize() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.db.connect();
            console.log('[GraphRegistry] Initialized successfully');
        });
    }
    getGraph(graphId, userId) {
        return __awaiter(this, void 0, void 0, function* () {
            const cacheKey = `${userId}:${graphId}`;
            let compiled = this.compiledCache.get(cacheKey);
            if (compiled) {
                console.log(`[GraphRegistry] Cache hit for graph: ${graphId} (user: ${userId})`);
                return compiled;
            }
            console.log(`[GraphRegistry] Cache miss for graph: ${graphId} (user: ${userId})`);
            const graphConfig = yield this.getConfig(graphId, userId);
            yield this.validateAccess(graphConfig, userId);
            try {
                compiled = (0, compiler_1.compileGraphFromConfig)(graphConfig);
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                throw new compiler_1.GraphCompilationError(`Failed to compile graph '${graphId}': ${errorMessage}`, graphId);
            }
            this.compiledCache.set(cacheKey, compiled);
            console.log(`[GraphRegistry] Compiled and cached graph: ${graphId}`);
            this.updateUsageStats(graphId, userId).catch((err) => {
                console.error(`[GraphRegistry] Failed to update usage stats for ${graphId}:`, err);
            });
            return compiled;
        });
    }
    getConfig(graphId, userId) {
        return __awaiter(this, void 0, void 0, function* () {
            const cacheKey = `${userId}:${graphId}`;
            const cached = this.configCache.get(cacheKey);
            if (cached) {
                console.log(`[GraphRegistry] Config cache hit: ${graphId}`);
                return cached;
            }
            const doc = yield Graph_1.Graph.findOne({
                graphId,
                $or: [{ userId }, { userId: 'system' }],
            });
            if (!doc)
                throw new GraphNotFoundError(`Graph '${graphId}' not found for user ${userId}`);
            const rawConfig = doc.toObject();
            const executionSource = rawConfig.published
                ? { nodes: rawConfig.published.nodes, edges: rawConfig.published.edges }
                : { nodes: rawConfig.nodes, edges: rawConfig.edges };
            const graphConfig = Object.assign(Object.assign({}, rawConfig), { nodes: executionSource.nodes, edges: (executionSource.edges || []).map((edge) => (Object.assign(Object.assign({}, edge), { targets: edge.targets instanceof Map ? Object.fromEntries(edge.targets) : edge.targets }))) });
            this.configCache.set(cacheKey, graphConfig);
            console.log(`[GraphRegistry] Config loaded from DB: ${graphId}`);
            return graphConfig;
        });
    }
    validateAccess(graphConfig, userId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (graphConfig.userId === userId)
                return;
            if (graphConfig.userId === 'system') {
                const userTier = yield this.getUserTier(userId);
                if (userTier > graphConfig.tier) {
                    throw new GraphAccessDeniedError(`Graph '${graphConfig.graphId}' requires tier ${graphConfig.tier} or higher (user has tier ${userTier})`);
                }
                return;
            }
            throw new GraphAccessDeniedError(`Graph '${graphConfig.graphId}' is private and owned by another user`);
        });
    }
    getUserTier(userId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const mongoose = require('mongoose');
                let User;
                try {
                    User = mongoose.model('User');
                }
                catch (_a) {
                    const userSchema = new mongoose.Schema({}, { collection: 'users', strict: false });
                    User = mongoose.model('User', userSchema);
                }
                const user = yield User.findById(userId).lean();
                if (user && typeof user.accountLevel === 'number')
                    return user.accountLevel;
                return 4;
            }
            catch (error) {
                console.error('[GraphRegistry] Error loading user tier:', error);
                return 4;
            }
        });
    }
    getUserGraphs(userId) {
        return __awaiter(this, void 0, void 0, function* () {
            const userTier = yield this.getUserTier(userId);
            const docs = yield Graph_1.Graph.find({
                $or: [
                    { userId },
                    { userId: 'system', tier: { $gte: userTier } },
                ],
            });
            return docs.map((doc) => doc.toObject());
        });
    }
    updateUsageStats(graphId, userId) {
        return __awaiter(this, void 0, void 0, function* () {
            yield Graph_1.Graph.updateOne({ graphId, $or: [{ userId }, { userId: 'system' }] }, { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }).exec();
        });
    }
    clearCache(userId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (userId) {
                let clearedCount = 0;
                for (const key of this.compiledCache.keys()) {
                    if (key.startsWith(`${userId}:`)) {
                        this.compiledCache.delete(key);
                        this.configCache.delete(key);
                        clearedCount++;
                    }
                }
                console.log(`[GraphRegistry] Cleared cache for user ${userId} (${clearedCount} entries)`);
            }
            else {
                this.compiledCache.clear();
                this.configCache.clear();
                console.log('[GraphRegistry] Cleared all caches');
            }
        });
    }
    getCacheStats() {
        return {
            compiled: { size: this.compiledCache.size, max: this.compiledCache.max },
            config: { size: this.configCache.size, max: this.configCache.max },
        };
    }
    subscribeToInvalidations(redisUrl) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const Redis = require('ioredis');
                const sub = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
                sub.on('error', (err) => {
                    console.error('[GraphRegistry] Redis sub error:', err.message);
                });
                yield sub.subscribe('graph:invalidate');
                sub.on('message', (_channel, graphId) => {
                    let cleared = 0;
                    for (const key of this.compiledCache.keys()) {
                        if (key.endsWith(':' + graphId)) {
                            this.compiledCache.delete(key);
                            cleared++;
                        }
                    }
                    for (const key of this.configCache.keys()) {
                        if (key.endsWith(':' + graphId)) {
                            this.configCache.delete(key);
                            cleared++;
                        }
                    }
                    console.log(`[GraphRegistry] Cache invalidated via pub/sub for graph: ${graphId} (${cleared} entries cleared)`);
                });
                console.log('[GraphRegistry] Subscribed to graph:invalidate channel');
            }
            catch (err) {
                console.error('[GraphRegistry] Failed to subscribe to invalidations:', err);
            }
        });
    }
    watchCollection(mongoDb) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const changeStream = mongoDb.collection('graphs').watch([{ $match: { operationType: { $in: ['update', 'replace'] } } }], { fullDocument: 'updateLookup' });
                changeStream.on('change', (change) => {
                    const graphId = change.fullDocument && change.fullDocument.graphId;
                    if (!graphId)
                        return;
                    let cleared = 0;
                    for (const key of this.compiledCache.keys()) {
                        if (key.endsWith(':' + graphId)) {
                            this.compiledCache.delete(key);
                            cleared++;
                        }
                    }
                    for (const key of this.configCache.keys()) {
                        if (key.endsWith(':' + graphId)) {
                            this.configCache.delete(key);
                            cleared++;
                        }
                    }
                    console.log(`[GraphRegistry] Cache invalidated via change stream for graph: ${graphId} (${cleared} entries cleared)`);
                });
                changeStream.on('error', (err) => {
                    console.error('[GraphRegistry] Change stream error:', err.message);
                });
                console.log('[GraphRegistry] Watching graphs collection for changes');
            }
            catch (err) {
                console.error('[GraphRegistry] Failed to start change stream watcher:', err);
            }
        });
    }
    shutdown() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.db.close();
            console.log('[GraphRegistry] Shut down');
        });
    }
}
exports.GraphRegistry = GraphRegistry;
