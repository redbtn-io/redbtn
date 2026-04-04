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
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageQueue = void 0;
class MessageQueue {
    constructor(redis) {
        this.STATE_TTL = 3600; // 1 hour TTL for message states
        this.CONTENT_KEY_PREFIX = 'message:generating:';
        this.INDEX_KEY_PREFIX = 'conversation:generating:';
        this.PUBSUB_PREFIX = 'message:stream:';
        this.STREAM_READY_PREFIX = 'stream:ready:';
        this.redis = redis;
    }
    /**
     * Signal that a stream client is connected and ready to receive events
     */
    markStreamReady(messageId) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = `${this.STREAM_READY_PREFIX}${messageId}`;
            yield this.redis.setex(key, 60, '1'); // 60 second TTL
            console.log(`[MessageQueue] Stream marked ready for ${messageId}`);
        });
    }
    /**
     * Wait for stream client to be ready before starting generation
     * Returns true if ready, false if timeout
     */
    waitForStreamReady(messageId_1) {
        return __awaiter(this, arguments, void 0, function* (messageId, timeoutMs = 5000) {
            const key = `${this.STREAM_READY_PREFIX}${messageId}`;
            const startTime = Date.now();
            while (Date.now() - startTime < timeoutMs) {
                const ready = yield this.redis.get(key);
                if (ready === '1') {
                    console.log(`[MessageQueue] Stream is ready for ${messageId}`);
                    return true;
                }
                // Wait 50ms before checking again
                yield new Promise(resolve => setTimeout(resolve, 50));
            }
            console.warn(`[MessageQueue] Timeout waiting for stream ready for ${messageId}`);
            return false; // Start anyway after timeout
        });
    }
    /**
     * Start tracking a new message generation
     */
    startGeneration(conversationId, messageId) {
        return __awaiter(this, void 0, void 0, function* () {
            const state = {
                conversationId,
                messageId,
                status: 'generating',
                content: '',
                startedAt: Date.now(),
                currentStatus: {
                    action: 'initializing',
                    description: 'Starting generation'
                }
            };
            const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
            yield this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
            // Add to conversation's generating messages index
            yield this.redis.sadd(`${this.INDEX_KEY_PREFIX}${conversationId}`, messageId);
            yield this.redis.expire(`${this.INDEX_KEY_PREFIX}${conversationId}`, this.STATE_TTL);
            // Publish initial status event so frontend knows generation started
            yield this.redis.publish(`${this.PUBSUB_PREFIX}${messageId}`, JSON.stringify({ type: 'status', action: 'initializing', description: 'Starting generation' }));
            console.log(`[MessageQueue] Started generation tracking: ${messageId}`);
        });
    }
    /**
     * Append content to a generating message (called as tokens stream in)
     */
    appendContent(messageId, chunk) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
            const stateJson = yield this.redis.get(key);
            if (!stateJson) {
                console.warn(`[MessageQueue] Cannot append to non-existent message: ${messageId}`);
                return;
            }
            const state = JSON.parse(stateJson);
            state.content += chunk;
            yield this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
            // Publish chunk to pub/sub channel for real-time streaming
            yield this.redis.publish(`${this.PUBSUB_PREFIX}${messageId}`, JSON.stringify({ type: 'chunk', content: chunk }));
        });
    }
    /**
     * Mark message generation as completed
     */
    completeGeneration(messageId, metadata) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
            const stateJson = yield this.redis.get(key);
            if (!stateJson) {
                console.warn(`[MessageQueue] Cannot complete non-existent message: ${messageId}`);
                return;
            }
            const state = JSON.parse(stateJson);
            state.status = 'completed';
            state.completedAt = Date.now();
            if (metadata) {
                state.metadata = metadata;
            }
            yield this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
            // Remove from generating index
            yield this.redis.srem(`${this.INDEX_KEY_PREFIX}${state.conversationId}`, messageId);
            // Publish completion event
            yield this.redis.publish(`${this.PUBSUB_PREFIX}${messageId}`, JSON.stringify({ type: 'complete', metadata }));
            console.log(`[MessageQueue] Completed generation: ${messageId} (${state.content.length} chars)`);
        });
    }
    /**
     * Publish tool status indicator (searching, scraping, etc.)
     */
    publishToolStatus(messageId, toolInfo) {
        return __awaiter(this, void 0, void 0, function* () {
            console.log(`[MessageQueue] publishToolStatus called for ${messageId}:`, toolInfo);
            // Store in state so SSE connection can retrieve it
            const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
            const stateJson = yield this.redis.get(key);
            if (stateJson) {
                const state = JSON.parse(stateJson);
                console.log(`[MessageQueue] Current state before update:`, { currentStatus: state.currentStatus });
                state.currentStatus = Object.assign(Object.assign({ action: toolInfo.action, description: toolInfo.status }, (toolInfo.reasoning && { reasoning: toolInfo.reasoning })), (toolInfo.confidence !== undefined && { confidence: toolInfo.confidence }));
                yield this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
                console.log(`[MessageQueue] Updated state.currentStatus to:`, state.currentStatus);
            }
            else {
                console.warn(`[MessageQueue] No state found for ${messageId}, cannot store tool status`);
            }
            // Publish tool status event (include reasoning if provided)
            yield this.redis.publish(`${this.PUBSUB_PREFIX}${messageId}`, JSON.stringify(Object.assign({ type: 'tool_status' }, toolInfo)));
            console.log(`[MessageQueue] Published tool_status event to pub/sub for ${messageId}`);
        });
    }
    /**
     * Publish general status update (routing, thinking, processing, etc.)
     */
    publishStatus(messageId, status) {
        return __awaiter(this, void 0, void 0, function* () {
            console.log(`[MessageQueue] Publishing status for ${messageId}:`, status.action);
            // Store in state so SSE connection can retrieve it
            const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
            const stateJson = yield this.redis.get(key);
            if (stateJson) {
                const state = JSON.parse(stateJson);
                state.currentStatus = status;
                yield this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
            }
            // Publish status event
            yield this.redis.publish(`${this.PUBSUB_PREFIX}${messageId}`, JSON.stringify(Object.assign({ type: 'status' }, status)));
        });
    }
    /**
     * Publish thinking/reasoning content chunk by chunk
     */
    publishThinkingChunk(messageId, chunk) {
        return __awaiter(this, void 0, void 0, function* () {
            // Accumulate thinking content in Redis state for reconnection
            const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
            const stateJson = yield this.redis.get(key);
            if (stateJson) {
                const state = JSON.parse(stateJson);
                state.thinking = (state.thinking || '') + chunk;
                yield this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
            }
            // Silent - too noisy to log each chunk
            yield this.redis.publish(`${this.PUBSUB_PREFIX}${messageId}`, JSON.stringify({ type: 'chunk', content: chunk, thinking: true }));
        });
    }
    /**
     * Publish thinking complete event (when </think> tag is closed)
     */
    publishThinkingComplete(messageId) {
        return __awaiter(this, void 0, void 0, function* () {
            console.log('[MessageQueue] Publishing thinking complete event for', messageId);
            yield this.redis.publish(`${this.PUBSUB_PREFIX}${messageId}`, JSON.stringify({ type: 'thinkingComplete' }));
        });
    }
    /**
     * Publish tool event to Redis pub/sub
     * Simple wrapper that doesn't require ToolEvent types
     */
    publishToolEvent(messageId, event) {
        return __awaiter(this, void 0, void 0, function* () {
            // Accumulate tool events in Redis state for reconnection
            const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
            const stateJson = yield this.redis.get(key);
            if (stateJson) {
                const state = JSON.parse(stateJson);
                if (!state.toolEvents) {
                    state.toolEvents = [];
                }
                state.toolEvents.push(event);
                yield this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
            }
            // Also publish to real-time pub/sub
            yield this.redis.publish(`${this.PUBSUB_PREFIX}${messageId}`, JSON.stringify({ type: 'tool_event', event }));
            if (event.type !== 'tool_progress') {
                console.log(`[MessageQueue] Published tool event: ${event.type} for ${event.toolName || event.toolId}`);
            }
        });
    }
    /**
     * Mark message generation as failed
     */
    failGeneration(messageId, error) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
            const stateJson = yield this.redis.get(key);
            if (!stateJson) {
                console.warn(`[MessageQueue] Cannot fail non-existent message: ${messageId}`);
                return;
            }
            const state = JSON.parse(stateJson);
            state.status = 'error';
            state.error = error;
            state.completedAt = Date.now();
            yield this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
            // Remove from generating index
            yield this.redis.srem(`${this.INDEX_KEY_PREFIX}${state.conversationId}`, messageId);
            // Publish error event
            yield this.redis.publish(`${this.PUBSUB_PREFIX}${messageId}`, JSON.stringify({ type: 'error', error }));
            console.error(`[MessageQueue] Failed generation: ${messageId} - ${error}`);
        });
    }
    /**
     * Get current state of a generating message
     */
    getMessageState(messageId) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
            const stateJson = yield this.redis.get(key);
            if (!stateJson) {
                return null;
            }
            return JSON.parse(stateJson);
        });
    }
    /**
     * Get all generating messages for a conversation
     */
    getGeneratingMessages(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const messageIds = yield this.redis.smembers(`${this.INDEX_KEY_PREFIX}${conversationId}`);
            if (messageIds.length === 0) {
                return [];
            }
            const states = [];
            for (const messageId of messageIds) {
                const state = yield this.getMessageState(messageId);
                if (state) {
                    states.push(state);
                }
            }
            return states;
        });
    }
    /**
     * Clean up completed/failed message state
     */
    cleanupMessage(messageId) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
            yield this.redis.del(key);
        });
    }
    /**
     * Subscribe to a message stream via Redis pub/sub
     * Returns an async generator that yields chunks, completion, or errors
     */
    subscribeToMessage(messageId) {
        return __asyncGenerator(this, arguments, function* subscribeToMessage_1() {
            var _a, e_1, _b, _c;
            // First, get any existing content
            const state = yield __await(this.getMessageState(messageId));
            if (!state) {
                throw new Error(`Message ${messageId} not found`);
            }
            // Yield existing content if any
            if (state.content) {
                yield yield __await({ type: 'init', existingContent: state.content });
            }
            // Yield current status if any (this is the key fix!)
            if (state.currentStatus) {
                console.log(`[MessageQueue] Sending stored status to new SSE connection: ${state.currentStatus.action}`);
                yield yield __await({
                    type: state.currentStatus.action.includes('search') || state.currentStatus.action.includes('scrape') || state.currentStatus.action.includes('command')
                        ? 'tool_status'
                        : 'status',
                    action: state.currentStatus.action,
                    description: state.currentStatus.description,
                    status: state.currentStatus.description
                });
            }
            // If already completed, just send completion event
            if (state.status === 'completed') {
                yield yield __await({ type: 'complete', metadata: state.metadata });
                return yield __await(void 0);
            }
            if (state.status === 'error') {
                yield yield __await({ type: 'error', error: state.error });
                return yield __await(void 0);
            }
            // Subscribe to pub/sub for new chunks
            const subscriber = this.redis.duplicate();
            // Increase max listeners to prevent warnings when multiple clients connect
            subscriber.setMaxListeners(50);
            const channel = `${this.PUBSUB_PREFIX}${messageId}`;
            const getState = this.getMessageState.bind(this);
            let cleanedUp = false;
            const cleanup = () => __awaiter(this, void 0, void 0, function* () {
                if (cleanedUp)
                    return;
                cleanedUp = true;
                try {
                    yield subscriber.unsubscribe(channel);
                    yield subscriber.quit();
                    console.log(`[MessageQueue] Cleaned up subscriber for ${messageId}`);
                }
                catch (e) {
                    // Ignore cleanup errors
                }
            });
            try {
                yield __await(subscriber.subscribe(channel));
                console.log(`[MessageQueue] Redis subscription established for ${messageId}`);
                // Create a promise-based message handler
                const messageIterator = function (sub) {
                    return __asyncGenerator(this, arguments, function* () {
                        while (true) {
                            const message = yield __await(new Promise((resolve) => {
                                sub.once('message', (ch, msg) => {
                                    if (ch === channel) {
                                        resolve(msg);
                                    }
                                });
                                // Timeout after 30 seconds of no activity
                                setTimeout(() => resolve(null), 30000);
                            }));
                            if (message === null) {
                                // Timeout - check if generation completed
                                const currentState = yield __await(getState(messageId));
                                if (!currentState || currentState.status !== 'generating') {
                                    break;
                                }
                                continue;
                            }
                            yield yield __await(message);
                        }
                    });
                }(subscriber);
                try {
                    for (var _d = true, messageIterator_1 = __asyncValues(messageIterator), messageIterator_1_1; messageIterator_1_1 = yield __await(messageIterator_1.next()), _a = messageIterator_1_1.done, !_a; _d = true) {
                        _c = messageIterator_1_1.value;
                        _d = false;
                        const message = _c;
                        const event = JSON.parse(message);
                        if (event.type === 'chunk') {
                            // Forward chunk events with thinking property if present
                            yield yield __await({ type: 'chunk', content: event.content, thinking: event.thinking });
                        }
                        else if (event.type === 'status') {
                            yield yield __await({ type: 'status', action: event.action, description: event.description });
                        }
                        else if (event.type === 'thinking') {
                            yield yield __await({ type: 'thinking', content: event.content });
                        }
                        else if (event.type === 'tool_status') {
                            yield yield __await({ type: 'tool_status', status: event.status, action: event.action });
                        }
                        else if (event.type === 'tool_event') {
                            yield yield __await({ type: 'tool_event', event: event.event });
                        }
                        else if (event.type === 'complete') {
                            yield yield __await({ type: 'complete', metadata: event.metadata });
                            break;
                        }
                        else if (event.type === 'error') {
                            yield yield __await({ type: 'error', error: event.error });
                            break;
                        }
                    }
                }
                catch (e_1_1) { e_1 = { error: e_1_1 }; }
                finally {
                    try {
                        if (!_d && !_a && (_b = messageIterator_1.return)) yield __await(_b.call(messageIterator_1));
                    }
                    finally { if (e_1) throw e_1.error; }
                }
            }
            finally {
                yield __await(cleanup());
            }
        });
    }
}
exports.MessageQueue = MessageQueue;
