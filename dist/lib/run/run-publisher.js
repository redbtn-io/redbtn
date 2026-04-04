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
exports.RunPublisher = void 0;
exports.createRunPublisher = createRunPublisher;
exports.getActiveRunForConversation = getActiveRunForConversation;
exports.getRunState = getRunState;
const redstream_1 = require("@redbtn/redstream");
const types_1 = require("./types");
const conversation_1 = require("../conversation");
// Debug logging - set to true to enable verbose logs
const DEBUG = false;
/**
 * RunPublisher - Unified run state and event publisher
 */
class RunPublisher {
    constructor(options) {
        var _a;
        this.state = null;
        this.initialized = false;
        /** ConversationPublisher for forwarding events to the chat UI */
        this.convPublisher = null;
        /** Message ID used for conversation stream (stable across run lifetime) */
        this.convMessageId = null;
        this.redis = options.redis;
        this.runId = options.runId;
        this.userId = options.userId;
        this.stateTtl = (_a = options.stateTtl) !== null && _a !== void 0 ? _a : types_1.RunConfig.STATE_TTL_SECONDS;
        this.redlog = options.log;
    }
    get id() {
        return this.runId;
    }
    get user() {
        return this.userId;
    }
    // ===========================================================================
    // Persistent Logging Helper
    // ===========================================================================
    persistLog(params) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const meta = Object.assign({ runId: this.runId, userId: this.userId, graphId: (_a = this.state) === null || _a === void 0 ? void 0 : _a.graphId, graphName: (_b = this.state) === null || _b === void 0 ? void 0 : _b.graphName }, params.metadata);
            if (!this.redlog)
                return;
            try {
                yield this.redlog.log({
                    level: params.level,
                    message: params.message,
                    category: params.category,
                    scope: {
                        conversationId: (_c = this.state) === null || _c === void 0 ? void 0 : _c.conversationId,
                        generationId: this.runId,
                    },
                    metadata: meta,
                });
            }
            catch (error) {
                if (DEBUG)
                    console.error('[RunPublisher] redlog error:', error);
            }
        });
    }
    // ===========================================================================
    // Lifecycle Methods
    // ===========================================================================
    init(graphId, graphName, input, conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.initialized) {
                throw new Error(`RunPublisher already initialized for run ${this.runId}`);
            }
            this.state = (0, types_1.createInitialRunState)({
                runId: this.runId,
                userId: this.userId,
                graphId,
                graphName,
                input,
                conversationId,
            });
            yield this.saveState();
            if (conversationId) {
                yield this.redis.set(types_1.RunKeys.conversationRun(conversationId), this.runId, 'EX', this.stateTtl);
                // Create ConversationPublisher for forwarding events to the chat UI
                try {
                    this.convPublisher = (0, conversation_1.createConversationPublisher)({
                        redis: this.redis,
                        conversationId,
                        userId: this.userId,
                    });
                    this.convMessageId = `msg_run_${this.runId}`;
                    yield this.convPublisher.publishRunStart(this.runId, this.convMessageId, graphId, graphName);
                    if (DEBUG)
                        console.log(`[RunPublisher] Conversation forwarding enabled for ${conversationId}`);
                }
                catch (err) {
                    console.warn('[RunPublisher] Failed to create conversation publisher:', err);
                    this.convPublisher = null;
                }
            }
            yield this.publish({
                type: 'run_start',
                graphId,
                graphName,
                timestamp: Date.now(),
            });
            yield this.persistLog({
                level: 'info',
                category: 'run',
                message: `Run started: ${graphName}`,
                metadata: { graphId, graphName, input },
            });
            this.initialized = true;
        });
    }
    complete(output) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            this.ensureInitialized();
            if (output) {
                if (output.content !== undefined)
                    this.state.output.content = output.content;
                if (output.thinking !== undefined)
                    this.state.output.thinking = output.thinking;
                if (output.data !== undefined)
                    this.state.output.data = output.data;
            }
            this.state.status = 'completed';
            this.state.completedAt = Date.now();
            yield this.saveState();
            if (this.state.conversationId) {
                yield this.redis.del(types_1.RunKeys.conversationRun(this.state.conversationId));
            }
            // Forward to conversation stream
            if (this.convPublisher && this.convMessageId) {
                try {
                    yield this.convPublisher.publishRunComplete(this.runId, this.convMessageId, this.state.output.content || undefined);
                }
                catch (err) {
                    if (DEBUG)
                        console.warn('[RunPublisher] Conv forward run_complete failed:', err);
                }
            }
            yield this.publish({
                type: 'run_complete',
                metadata: this.state.metadata,
                timestamp: Date.now(),
            });
            const duration = this.state.completedAt - this.state.startedAt;
            yield this.persistLog({
                level: 'info',
                category: 'run',
                message: `Run completed: ${this.state.graphName}`,
                metadata: {
                    duration,
                    nodesExecuted: this.state.graph.nodesExecuted,
                    tokenUsage: (_b = (_a = this.state.metadata) === null || _a === void 0 ? void 0 : _a.tokens) === null || _b === void 0 ? void 0 : _b.total,
                },
            });
        });
    }
    fail(error) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            this.state.status = 'error';
            this.state.error = error;
            this.state.completedAt = Date.now();
            yield this.saveState();
            if (this.state.conversationId) {
                yield this.redis.del(types_1.RunKeys.conversationRun(this.state.conversationId));
            }
            // Forward to conversation stream
            if (this.convPublisher && this.convMessageId) {
                try {
                    yield this.convPublisher.publishRunError(this.runId, this.convMessageId, error);
                }
                catch (err) {
                    if (DEBUG)
                        console.warn('[RunPublisher] Conv forward run_error failed:', err);
                }
            }
            yield this.publish({ type: 'run_error', error, timestamp: Date.now() });
            yield this.persistLog({
                level: 'error',
                category: 'run',
                message: `Run failed: ${error}`,
                metadata: { error },
            });
        });
    }
    // ===========================================================================
    // Status Updates
    // ===========================================================================
    status(action, description) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            this.state.currentStatus = { action, description };
            yield this.saveState();
            yield this.publish({ type: 'status', action, description, timestamp: Date.now() });
        });
    }
    // ===========================================================================
    // Graph Events
    // ===========================================================================
    graphStart(nodeCount, entryNodeId) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            this.state.status = 'running';
            this.state.graph.entryNodeId = entryNodeId;
            yield this.saveState();
            yield this.publish({
                type: 'graph_start',
                runId: this.runId,
                graphId: this.state.graphId,
                graphName: this.state.graphName,
                nodeCount,
                entryNodeId,
                timestamp: Date.now(),
            });
        });
    }
    graphComplete(exitNodeId, nodesExecuted) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            const duration = Date.now() - this.state.startedAt;
            if (exitNodeId)
                this.state.graph.exitNodeId = exitNodeId;
            if (nodesExecuted !== undefined)
                this.state.graph.nodesExecuted = nodesExecuted;
            yield this.saveState();
            yield this.publish({
                type: 'graph_complete',
                exitNodeId,
                nodesExecuted: this.state.graph.nodesExecuted,
                duration,
                timestamp: Date.now(),
            });
        });
    }
    graphError(error, failedNodeId) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            yield this.publish({ type: 'graph_error', error, failedNodeId, timestamp: Date.now() });
        });
    }
    // ===========================================================================
    // Node Events
    // ===========================================================================
    nodeStart(nodeId, nodeType, nodeName) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            const timestamp = Date.now();
            this.state.graph.nodeProgress[nodeId] = (0, types_1.createNodeProgress)({ nodeName, nodeType });
            this.state.graph.nodeProgress[nodeId].status = 'running';
            this.state.graph.nodeProgress[nodeId].startedAt = timestamp;
            this.state.graph.executionPath.push(nodeId);
            if (DEBUG) {
                try {
                    console.log(`[RunPublisher] nodeStart run=${this.runId} node=${nodeId}`);
                }
                catch (_e) { /* ignore */ }
            }
            yield this.saveState();
            yield this.publish({ type: 'node_start', runId: this.runId, nodeId, nodeType, nodeName, timestamp });
            yield this.persistLog({
                level: 'info',
                category: 'node',
                message: `Node started: ${nodeName}`,
                metadata: { nodeId, nodeType, nodeName },
            });
        });
    }
    nodeProgress(nodeId, step, options) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            const nodeProgress = this.state.graph.nodeProgress[nodeId];
            if (nodeProgress) {
                nodeProgress.steps.push({ name: step, timestamp: Date.now(), data: options === null || options === void 0 ? void 0 : options.data });
            }
            yield this.saveState();
            yield this.publish({
                type: 'node_progress',
                nodeId,
                step,
                stepIndex: options === null || options === void 0 ? void 0 : options.index,
                totalSteps: options === null || options === void 0 ? void 0 : options.total,
                data: options === null || options === void 0 ? void 0 : options.data,
                timestamp: Date.now(),
            });
            const stepLabel = (options === null || options === void 0 ? void 0 : options.index) != null && (options === null || options === void 0 ? void 0 : options.total) != null
                ? `Step ${options.index + 1}/${options.total}: ${step}`
                : `Step: ${step}`;
            yield this.persistLog({
                level: 'info',
                category: 'node',
                message: stepLabel,
                metadata: Object.assign({ nodeId, step, stepIndex: options === null || options === void 0 ? void 0 : options.index, totalSteps: options === null || options === void 0 ? void 0 : options.total }, options === null || options === void 0 ? void 0 : options.data),
            });
        });
    }
    nodeComplete(nodeId, nextNodeId, output) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            this.ensureInitialized();
            const nodeProgress = this.state.graph.nodeProgress[nodeId];
            if (nodeProgress) {
                nodeProgress.status = 'completed';
                nodeProgress.completedAt = Date.now();
                nodeProgress.duration = nodeProgress.startedAt ? Date.now() - nodeProgress.startedAt : undefined;
            }
            if (DEBUG) {
                try {
                    console.log(`[RunPublisher] nodeComplete run=${this.runId} node=${nodeId} duration_ms=${(_a = nodeProgress === null || nodeProgress === void 0 ? void 0 : nodeProgress.duration) !== null && _a !== void 0 ? _a : 'n/a'}`);
                }
                catch (_e) { /* ignore */ }
            }
            this.state.graph.nodesExecuted++;
            if (output) {
                this.state.output.data = Object.assign(Object.assign({}, this.state.output.data), output);
            }
            yield this.saveState();
            yield this.publish({
                type: 'node_complete',
                nodeId,
                nextNodeId,
                duration: (_b = nodeProgress === null || nodeProgress === void 0 ? void 0 : nodeProgress.duration) !== null && _b !== void 0 ? _b : 0,
                timestamp: Date.now(),
            });
            yield this.persistLog({
                level: 'info',
                category: 'node',
                message: `Node completed: ${(_c = nodeProgress === null || nodeProgress === void 0 ? void 0 : nodeProgress.nodeName) !== null && _c !== void 0 ? _c : nodeId}`,
                metadata: { nodeId, nodeType: nodeProgress === null || nodeProgress === void 0 ? void 0 : nodeProgress.nodeType, duration: nodeProgress === null || nodeProgress === void 0 ? void 0 : nodeProgress.duration, nextNodeId },
            });
        });
    }
    nodeError(nodeId, error) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            const nodeProgress = this.state.graph.nodeProgress[nodeId];
            if (nodeProgress) {
                nodeProgress.status = 'error';
                nodeProgress.error = error;
                nodeProgress.completedAt = Date.now();
            }
            yield this.saveState();
            yield this.publish({ type: 'node_error', nodeId, error, timestamp: Date.now() });
            yield this.persistLog({
                level: 'error',
                category: 'node',
                message: `Node error: ${error}`,
                metadata: { nodeId, error },
            });
        });
    }
    // ===========================================================================
    // Streaming
    // ===========================================================================
    chunk(content) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            this.state.output.content += content;
            yield this.publish({ type: 'chunk', content, timestamp: Date.now() });
            // Forward to conversation stream
            if (this.convPublisher && this.convMessageId) {
                this.convPublisher.streamContent(this.runId, this.convMessageId, content).catch((err) => {
                    if (DEBUG)
                        console.warn('[RunPublisher] Conv forward content_chunk failed:', err);
                });
            }
        });
    }
    thinkingChunk(content) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            this.state.output.thinking += content;
            yield this.publish({ type: 'chunk', content, thinking: true, timestamp: Date.now() });
            // Forward to conversation stream
            if (this.convPublisher && this.convMessageId) {
                this.convPublisher.streamThinking(this.runId, this.convMessageId, content).catch((err) => {
                    if (DEBUG)
                        console.warn('[RunPublisher] Conv forward thinking_chunk failed:', err);
                });
            }
        });
    }
    thinkingComplete() {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            yield this.saveState();
            yield this.publish({ type: 'thinking_complete', timestamp: Date.now() });
        });
    }
    // ===========================================================================
    // Audio Streaming (Server-side TTS)
    // ===========================================================================
    publishAudioChunk(audioBase64, index, isFinal) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            yield this.publish({
                type: 'audio_chunk',
                audio: audioBase64,
                index,
                isFinal,
                format: 'mp3',
                timestamp: Date.now(),
            });
        });
    }
    // ===========================================================================
    // Tool Events
    // ===========================================================================
    toolStart(toolId, toolName, toolType, options) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            const tool = (0, types_1.createToolExecution)({ toolId, toolName, toolType });
            this.state.tools.push(tool);
            yield this.saveState();
            const ts = Date.now();
            yield this.publish({ type: 'tool_start', toolId, toolName, toolType, input: options === null || options === void 0 ? void 0 : options.input, timestamp: ts });
            // Forward to conversation stream
            if (this.convPublisher) {
                this.convPublisher.publishToolEvent(this.runId, {
                    type: 'tool_start', toolId, toolName, toolType, input: options === null || options === void 0 ? void 0 : options.input, timestamp: ts,
                }).catch(() => { });
            }
            yield this.persistLog({
                level: 'info',
                category: 'tool',
                message: `Tool started: ${toolName}`,
                metadata: { toolId, toolName, toolType, input: options === null || options === void 0 ? void 0 : options.input },
            });
        });
    }
    toolProgress(toolId, step, options) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            const tool = this.findTool(toolId);
            if (tool) {
                tool.steps.push({ name: step, timestamp: Date.now(), progress: options === null || options === void 0 ? void 0 : options.progress, data: options === null || options === void 0 ? void 0 : options.data });
            }
            yield this.saveState();
            const ts = Date.now();
            yield this.publish({ type: 'tool_progress', toolId, step, progress: options === null || options === void 0 ? void 0 : options.progress, data: options === null || options === void 0 ? void 0 : options.data, timestamp: ts });
            // Forward to conversation stream
            if (this.convPublisher) {
                this.convPublisher.publishToolEvent(this.runId, {
                    type: 'tool_progress', toolId, toolName: (tool === null || tool === void 0 ? void 0 : tool.toolName) || '', toolType: (tool === null || tool === void 0 ? void 0 : tool.toolType) || '',
                    step, progress: options === null || options === void 0 ? void 0 : options.progress, data: options === null || options === void 0 ? void 0 : options.data, timestamp: ts,
                }).catch(() => { });
            }
            yield this.persistLog({
                level: 'info',
                category: 'tool',
                message: `Tool progress: ${step}`,
                metadata: Object.assign({ toolId, step, progress: options === null || options === void 0 ? void 0 : options.progress }, options === null || options === void 0 ? void 0 : options.data),
            });
        });
    }
    toolComplete(toolId, result, metadata) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            this.ensureInitialized();
            const tool = this.findTool(toolId);
            if (tool) {
                tool.status = 'completed';
                tool.completedAt = Date.now();
                tool.duration = Date.now() - tool.startedAt;
                tool.result = result;
            }
            yield this.saveState();
            const ts = Date.now();
            yield this.publish({ type: 'tool_complete', toolId, result, metadata, timestamp: ts });
            // Forward to conversation stream
            if (this.convPublisher) {
                this.convPublisher.publishToolEvent(this.runId, {
                    type: 'tool_complete', toolId, toolName: (tool === null || tool === void 0 ? void 0 : tool.toolName) || '', toolType: (tool === null || tool === void 0 ? void 0 : tool.toolType) || '',
                    result, metadata, timestamp: ts,
                }).catch(() => { });
            }
            yield this.persistLog({
                level: 'info',
                category: 'tool',
                message: `Tool completed: ${(_a = tool === null || tool === void 0 ? void 0 : tool.toolName) !== null && _a !== void 0 ? _a : toolId}`,
                metadata: Object.assign({ toolId, toolName: tool === null || tool === void 0 ? void 0 : tool.toolName, duration: tool === null || tool === void 0 ? void 0 : tool.duration }, metadata),
            });
        });
    }
    toolError(toolId, error) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            const tool = this.findTool(toolId);
            if (tool) {
                tool.status = 'error';
                tool.completedAt = Date.now();
                tool.error = error;
            }
            yield this.saveState();
            const ts = Date.now();
            yield this.publish({ type: 'tool_error', toolId, error, timestamp: ts });
            // Forward to conversation stream
            if (this.convPublisher) {
                this.convPublisher.publishToolEvent(this.runId, {
                    type: 'tool_error', toolId, toolName: (tool === null || tool === void 0 ? void 0 : tool.toolName) || '', toolType: (tool === null || tool === void 0 ? void 0 : tool.toolType) || '',
                    error, timestamp: ts,
                }).catch(() => { });
            }
            yield this.persistLog({
                level: 'error',
                category: 'tool',
                message: `Tool error: ${error}`,
                metadata: { toolId, toolName: tool === null || tool === void 0 ? void 0 : tool.toolName, error },
            });
        });
    }
    // ===========================================================================
    // Metadata
    // ===========================================================================
    setMetadata(metadata) {
        return __awaiter(this, void 0, void 0, function* () {
            this.ensureInitialized();
            this.state.metadata = Object.assign(Object.assign({}, this.state.metadata), metadata);
            yield this.saveState();
        });
    }
    // ===========================================================================
    // State Access
    // ===========================================================================
    getState() {
        return __awaiter(this, void 0, void 0, function* () {
            const data = yield this.redis.get(types_1.RunKeys.state(this.runId));
            if (!data)
                return null;
            return JSON.parse(data);
        });
    }
    getCachedState() {
        return this.state;
    }
    // ===========================================================================
    // Subscription
    // ===========================================================================
    subscribe() {
        const channel = types_1.RunKeys.stream(this.runId);
        const eventsKey = types_1.RunKeys.events(this.runId);
        const sub = new redstream_1.StreamSubscriber({ redis: this.redis, channel, eventsKey });
        const generator = sub.subscribe({
            catchUp: true,
            terminalEvents: ['run_complete', 'run_error'],
            idleTimeoutMs: 30000,
            isAlive: () => __awaiter(this, void 0, void 0, function* () {
                const state = yield this.getState();
                return state !== null && state.status !== 'completed' && state.status !== 'error';
            }),
        });
        const ready = Promise.resolve();
        const unsubscribe = () => __awaiter(this, void 0, void 0, function* () { yield generator.return(undefined); });
        return { stream: generator, ready, unsubscribe };
    }
    getInitEvent() {
        return __awaiter(this, void 0, void 0, function* () {
            const state = yield this.getState();
            if (!state)
                return null;
            return { type: 'init', state, timestamp: Date.now() };
        });
    }
    // ===========================================================================
    // Private Helpers
    // ===========================================================================
    ensureInitialized() {
        if (!this.initialized || !this.state) {
            throw new Error(`RunPublisher not initialized. Call init() first for run ${this.runId}`);
        }
    }
    saveState() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.state)
                return;
            yield this.redis.set(types_1.RunKeys.state(this.runId), JSON.stringify(this.state), 'EX', this.stateTtl);
        });
    }
    publish(event) {
        return __awaiter(this, void 0, void 0, function* () {
            const channel = types_1.RunKeys.stream(this.runId);
            const eventsKey = types_1.RunKeys.events(this.runId);
            const pub = new redstream_1.StreamPublisher({ redis: this.redis, channel, eventsKey, ttl: this.stateTtl });
            yield pub.publish(event);
        });
    }
    getEvents() {
        return __awaiter(this, void 0, void 0, function* () {
            const pub = new redstream_1.StreamPublisher({
                redis: this.redis,
                channel: types_1.RunKeys.stream(this.runId),
                eventsKey: types_1.RunKeys.events(this.runId),
                ttl: this.stateTtl,
            });
            return pub.getEvents();
        });
    }
    getEventsSince(startIndex) {
        return __awaiter(this, void 0, void 0, function* () {
            const pub = new redstream_1.StreamPublisher({
                redis: this.redis,
                channel: types_1.RunKeys.stream(this.runId),
                eventsKey: types_1.RunKeys.events(this.runId),
                ttl: this.stateTtl,
            });
            return pub.getEventsSince(startIndex);
        });
    }
    getEventCount() {
        return __awaiter(this, void 0, void 0, function* () {
            const pub = new redstream_1.StreamPublisher({
                redis: this.redis,
                channel: types_1.RunKeys.stream(this.runId),
                eventsKey: types_1.RunKeys.events(this.runId),
                ttl: this.stateTtl,
            });
            return pub.getEventCount();
        });
    }
    findTool(toolId) {
        var _a;
        return (_a = this.state) === null || _a === void 0 ? void 0 : _a.tools.find((t) => t.toolId === toolId);
    }
}
exports.RunPublisher = RunPublisher;
// =============================================================================
// Factory Functions
// =============================================================================
function createRunPublisher(options) {
    return new RunPublisher(options);
}
function getActiveRunForConversation(redis, conversationId) {
    return __awaiter(this, void 0, void 0, function* () {
        const runId = yield redis.get(types_1.RunKeys.conversationRun(conversationId));
        if (!runId)
            return null;
        const stateJson = yield redis.get(types_1.RunKeys.state(runId));
        if (!stateJson) {
            yield redis.del(types_1.RunKeys.conversationRun(conversationId));
            return null;
        }
        const state = JSON.parse(stateJson);
        if (state.status === 'completed' || state.status === 'error') {
            yield redis.del(types_1.RunKeys.conversationRun(conversationId));
            return null;
        }
        return runId;
    });
}
function getRunState(redis, runId) {
    return __awaiter(this, void 0, void 0, function* () {
        const stateJson = yield redis.get(types_1.RunKeys.state(runId));
        if (!stateJson)
            return null;
        return JSON.parse(stateJson);
    });
}
