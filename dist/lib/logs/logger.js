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
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
const types_1 = require("./types");
/**
 * The most fantastic logging system known to man
 *
 * Features:
 * - Redis pub/sub for real-time log streaming
 * - 30-day TTL for all logs
 * - Generation-level tracking with unique IDs
 * - Thought logs separate from response logs
 * - Color tag support for frontends
 * - Conversation-level aggregated logs
 * - Concurrent generation prevention
 */
class Logger {
    constructor(redis) {
        this.redis = redis;
        // Increase max listeners for pub/sub
        this.redis.setMaxListeners(100);
    }
    /**
     * Generate a unique generation ID
     */
    generateGenerationId() {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 11);
        return `gen_${timestamp}_${random}`;
    }
    /**
     * Generate a unique log ID
     */
    generateLogId() {
        return `log_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    }
    /**
     * Start a new generation
     * Returns null if a generation is already in progress for this conversation
     * Automatically cleans up stale generations (older than 5 minutes)
     */
    startGeneration(conversationId, generationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const genId = generationId || this.generateGenerationId();
            // Check if a generation is already in progress
            const stateKey = types_1.RedisKeys.conversationGeneration(conversationId);
            const stateJson = yield this.redis.get(stateKey);
            if (stateJson) {
                const state = JSON.parse(stateJson);
                if (state.currentGenerationId) {
                    // Check if it's still actually generating
                    const genKey = types_1.RedisKeys.generation(state.currentGenerationId);
                    const genJson = yield this.redis.get(genKey);
                    if (genJson) {
                        const gen = JSON.parse(genJson);
                        if (gen.status === 'generating') {
                            // Check if generation is stale (older than 5 minutes)
                            const ageMs = Date.now() - gen.startedAt;
                            const maxAgeMs = 5 * 60 * 1000; // 5 minutes
                            if (ageMs > maxAgeMs) {
                                console.log(`[Logger] Cleaning up stale generation: ${state.currentGenerationId} (age: ${Math.round(ageMs / 1000)}s)`);
                                // Mark as error and allow new generation
                                yield this.failGeneration(state.currentGenerationId, 'Generation timed out (stale)');
                            }
                            else {
                                console.log(`[Logger] Generation already in progress: ${state.currentGenerationId} (age: ${Math.round(ageMs / 1000)}s)`);
                                return null; // Reject concurrent generation
                            }
                        }
                    }
                    else {
                        // Generation record not found, clean up state
                        console.log(`[Logger] Cleaning up orphaned generation state: ${state.currentGenerationId}`);
                        state.currentGenerationId = undefined;
                        yield this.redis.setex(stateKey, types_1.TTL.GENERATION, JSON.stringify(state));
                    }
                }
            }
            // Create generation record
            const generation = {
                id: genId,
                conversationId,
                status: 'generating',
                startedAt: Date.now(),
            };
            yield this.redis.setex(types_1.RedisKeys.generation(genId), types_1.TTL.GENERATION, JSON.stringify(generation));
            // Update conversation generation state
            const newState = {
                conversationId,
                currentGenerationId: genId,
                lastGenerationId: genId,
                generationCount: stateJson ? JSON.parse(stateJson).generationCount + 1 : 1,
            };
            yield this.redis.setex(stateKey, types_1.TTL.GENERATION, JSON.stringify(newState));
            // Log generation start
            yield this.log({
                level: 'info',
                category: 'generation',
                message: `<cyan>Generation started</cyan>`,
                generationId: genId,
                conversationId,
            });
            return genId;
        });
    }
    /**
     * Complete a generation
     */
    completeGeneration(generationId, data) {
        return __awaiter(this, void 0, void 0, function* () {
            const genKey = types_1.RedisKeys.generation(generationId);
            const genJson = yield this.redis.get(genKey);
            if (!genJson) {
                console.warn(`[Logger] Generation not found: ${generationId}`);
                return;
            }
            const generation = JSON.parse(genJson);
            generation.status = 'completed';
            generation.completedAt = Date.now();
            generation.response = data.response;
            generation.thinking = data.thinking;
            generation.route = data.route;
            generation.toolsUsed = data.toolsUsed;
            generation.model = data.model;
            generation.tokens = data.tokens;
            yield this.redis.setex(genKey, types_1.TTL.GENERATION, JSON.stringify(generation));
            // Clear current generation from conversation state
            const stateKey = types_1.RedisKeys.conversationGeneration(generation.conversationId);
            const stateJson = yield this.redis.get(stateKey);
            if (stateJson) {
                const state = JSON.parse(stateJson);
                if (state.currentGenerationId === generationId) {
                    state.currentGenerationId = undefined;
                    yield this.redis.setex(stateKey, types_1.TTL.GENERATION, JSON.stringify(state));
                }
            }
            // Log completion
            const duration = generation.completedAt - generation.startedAt;
            yield this.log({
                level: 'success',
                category: 'generation',
                message: `<green>Generation completed</green> <dim>(${duration}ms)</dim>`,
                generationId,
                conversationId: generation.conversationId,
                metadata: {
                    duration,
                    tokens: data.tokens,
                    route: data.route,
                    toolsUsed: data.toolsUsed,
                },
            });
            // Also persist the assistant response as a chat log so UI and DB have the actual text
            if (data.response && typeof data.response === 'string') {
                const maxLen = 10000; // safety cutoff to avoid extremely large single logs
                const truncated = data.response.length > maxLen;
                const respText = truncated ? data.response.slice(0, maxLen) : data.response;
                yield this.log({
                    level: 'info',
                    category: 'chat',
                    message: respText,
                    generationId,
                    conversationId: generation.conversationId,
                    metadata: {
                        contentLength: data.response.length,
                        truncated,
                        model: data.model,
                    },
                });
            }
        });
    }
    /**
     * Fail a generation
     */
    failGeneration(generationId, error) {
        return __awaiter(this, void 0, void 0, function* () {
            const genKey = types_1.RedisKeys.generation(generationId);
            const genJson = yield this.redis.get(genKey);
            if (!genJson) {
                console.warn(`[Logger] Generation not found: ${generationId}`);
                return;
            }
            const generation = JSON.parse(genJson);
            generation.status = 'error';
            generation.completedAt = Date.now();
            generation.error = error;
            yield this.redis.setex(genKey, types_1.TTL.GENERATION, JSON.stringify(generation));
            // Clear current generation from conversation state
            const stateKey = types_1.RedisKeys.conversationGeneration(generation.conversationId);
            const stateJson = yield this.redis.get(stateKey);
            if (stateJson) {
                const state = JSON.parse(stateJson);
                if (state.currentGenerationId === generationId) {
                    state.currentGenerationId = undefined;
                    yield this.redis.setex(stateKey, types_1.TTL.GENERATION, JSON.stringify(state));
                }
            }
            // Log error
            yield this.log({
                level: 'error',
                category: 'generation',
                message: `<red>Generation failed:</red> ${error}`,
                generationId,
                conversationId: generation.conversationId,
                metadata: { error },
            });
        });
    }
    /**
     * Log a message
     */
    log(params) {
        return __awaiter(this, void 0, void 0, function* () {
            const logEntry = {
                id: this.generateLogId(),
                timestamp: Date.now(),
                level: params.level,
                category: params.category,
                message: params.message,
                generationId: params.generationId,
                conversationId: params.conversationId,
                metadata: params.metadata,
            };
            // Store individual log
            yield this.redis.setex(types_1.RedisKeys.log(logEntry.id), types_1.TTL.LOG, JSON.stringify(logEntry));
            // Add to generation logs list
            if (params.generationId) {
                const listKey = types_1.RedisKeys.generationLogs(params.generationId);
                yield this.redis.rpush(listKey, logEntry.id);
                yield this.redis.expire(listKey, types_1.TTL.LOG_LIST);
            }
            // Add to conversation logs list
            if (params.conversationId) {
                const listKey = types_1.RedisKeys.conversationLogs(params.conversationId);
                yield this.redis.rpush(listKey, logEntry.id);
                yield this.redis.expire(listKey, types_1.TTL.LOG_LIST);
            }
            // Publish to pub/sub channels
            const logJson = JSON.stringify(logEntry);
            // Publish to generation channel
            if (params.generationId) {
                yield this.redis.publish(types_1.RedisKeys.logChannel(params.generationId), logJson);
            }
            // Publish to conversation channel
            if (params.conversationId) {
                yield this.redis.publish(types_1.RedisKeys.conversationLogChannel(params.conversationId), logJson);
            }
            // Publish to all logs channel
            yield this.redis.publish(types_1.RedisKeys.allLogsChannel, logJson);
        });
    }
    /**
     * Log thinking/reasoning separately from responses
     */
    logThought(params) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.log({
                level: 'debug',
                category: 'thought',
                message: `<dim>💭 ${params.source} thinking:</dim>\n${params.content}`,
                generationId: params.generationId,
                conversationId: params.conversationId,
                metadata: Object.assign({ source: params.source }, params.metadata),
            });
        });
    }
    /**
     * Get all logs for a generation
     */
    getGenerationLogs(generationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const listKey = types_1.RedisKeys.generationLogs(generationId);
            const logIds = yield this.redis.lrange(listKey, 0, -1);
            const logs = [];
            for (const logId of logIds) {
                const logJson = yield this.redis.get(types_1.RedisKeys.log(logId));
                if (logJson) {
                    logs.push(JSON.parse(logJson));
                }
            }
            return logs;
        });
    }
    /**
     * Get all logs for a conversation
     */
    getConversationLogs(conversationId, limit) {
        return __awaiter(this, void 0, void 0, function* () {
            const listKey = types_1.RedisKeys.conversationLogs(conversationId);
            const logIds = yield this.redis.lrange(listKey, limit ? -limit : 0, -1);
            const logs = [];
            for (const logId of logIds) {
                const logJson = yield this.redis.get(types_1.RedisKeys.log(logId));
                if (logJson) {
                    logs.push(JSON.parse(logJson));
                }
            }
            return logs;
        });
    }
    /**
     * Get generation data
     */
    getGeneration(generationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const genJson = yield this.redis.get(types_1.RedisKeys.generation(generationId));
            return genJson ? JSON.parse(genJson) : null;
        });
    }
    /**
     * Get conversation generation state
     */
    getConversationGenerationState(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const stateJson = yield this.redis.get(types_1.RedisKeys.conversationGeneration(conversationId));
            return stateJson ? JSON.parse(stateJson) : null;
        });
    }
    /**
     * Subscribe to logs for a generation (real-time streaming)
     */
    subscribeToGeneration(generationId) {
        return __asyncGenerator(this, arguments, function* subscribeToGeneration_1() {
            const subscriber = this.redis.duplicate();
            subscriber.setMaxListeners(100);
            const channel = types_1.RedisKeys.logChannel(generationId);
            try {
                yield __await(subscriber.subscribe(channel));
                // Yield existing logs first
                const existingLogs = yield __await(this.getGenerationLogs(generationId));
                for (const log of existingLogs) {
                    yield yield __await(log);
                }
                // Then stream new logs
                while (true) {
                    const message = yield __await(new Promise((resolve) => {
                        subscriber.once('message', (ch, msg) => {
                            if (ch === channel)
                                resolve(msg);
                        });
                        // Timeout after 30 seconds
                        setTimeout(() => resolve(null), 30000);
                    }));
                    if (message === null) {
                        // Check if generation is complete
                        const gen = yield __await(this.getGeneration(generationId));
                        if (!gen || gen.status !== 'generating') {
                            break;
                        }
                        continue;
                    }
                    const logEntry = JSON.parse(message);
                    yield yield __await(logEntry);
                    // Break if generation complete/error log
                    if (logEntry.category === 'generation' &&
                        (logEntry.message.includes('completed') || logEntry.message.includes('failed'))) {
                        break;
                    }
                }
            }
            finally {
                yield __await(subscriber.unsubscribe(channel));
                yield __await(subscriber.quit());
            }
        });
    }
    /**
     * Subscribe to all logs for a conversation (real-time streaming)
     */
    subscribeToConversation(conversationId) {
        return __asyncGenerator(this, arguments, function* subscribeToConversation_1() {
            const subscriber = this.redis.duplicate();
            subscriber.setMaxListeners(100);
            const channel = types_1.RedisKeys.conversationLogChannel(conversationId);
            try {
                yield __await(subscriber.subscribe(channel));
                while (true) {
                    const message = yield __await(new Promise((resolve) => {
                        subscriber.once('message', (ch, msg) => {
                            if (ch === channel)
                                resolve(msg);
                        });
                        // Timeout after 60 seconds
                        setTimeout(() => resolve(null), 60000);
                    }));
                    if (message === null) {
                        continue; // Keep alive
                    }
                    const logEntry = JSON.parse(message);
                    yield yield __await(logEntry);
                }
            }
            finally {
                yield __await(subscriber.unsubscribe(channel));
                yield __await(subscriber.quit());
            }
        });
    }
}
exports.Logger = Logger;
