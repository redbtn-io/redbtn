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
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunPublisher = void 0;
exports.run = run;
exports.isStreamingResult = isStreamingResult;
const run_1 = require("../lib/run");
Object.defineProperty(exports, "RunPublisher", { enumerable: true, get: function () { return run_1.RunPublisher; } });
const connections_1 = require("../lib/connections");
const MongoCheckpointer_1 = require("../lib/graphs/MongoCheckpointer");
const graph_1 = require("../lib/types/graph");
// =============================================================================
// Configuration
// =============================================================================
const DEFAULT_GRAPH_ID = graph_1.SYSTEM_TEMPLATES.DEFAULT;
function generateRunId() {
    return `run_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}
function loadUserSettings(userId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const defaults = {
            accountTier: 4,
            defaultNeuronId: 'red-neuron',
            defaultWorkerNeuronId: 'red-neuron',
            defaultGraphId: DEFAULT_GRAPH_ID,
        };
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const mongoose = require('mongoose');
            let User;
            try {
                User = mongoose.model('User');
            }
            catch (_b) {
                const userSchema = new mongoose.Schema({}, { collection: 'users', strict: false });
                User = mongoose.model('User', userSchema);
            }
            const user = yield User.findById(userId).lean();
            if (user) {
                return {
                    accountTier: (_a = user.accountLevel) !== null && _a !== void 0 ? _a : defaults.accountTier,
                    defaultNeuronId: user.defaultNeuronId || defaults.defaultNeuronId,
                    defaultWorkerNeuronId: user.defaultWorkerNeuronId || defaults.defaultWorkerNeuronId,
                    defaultGraphId: user.defaultGraphId || defaults.defaultGraphId,
                };
            }
            console.warn(`[run] User ${userId} not found, using defaults`);
            return defaults;
        }
        catch (error) {
            console.error('[run] Error loading user settings:', error);
            return defaults;
        }
    });
}
function loadGraph(red, graphId, userId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        try {
            const compiledGraph = yield red.graphRegistry.getGraph(graphId, userId);
            return {
                compiledGraph,
                graphId,
                graphName: ((_a = compiledGraph.config) === null || _a === void 0 ? void 0 : _a.name) || graphId,
            };
        }
        catch (error) {
            const isRecoverable = error.name === 'GraphAccessDeniedError' ||
                error.name === 'GraphNotFoundError' ||
                ((_b = error.message) === null || _b === void 0 ? void 0 : _b.includes('requires tier')) ||
                ((_c = error.message) === null || _c === void 0 ? void 0 : _c.includes('not found'));
            if (isRecoverable && graphId !== DEFAULT_GRAPH_ID) {
                console.warn(`[run] Graph ${graphId} not accessible, falling back to ${DEFAULT_GRAPH_ID}`);
                return loadGraph(red, DEFAULT_GRAPH_ID, userId);
            }
            throw new Error(`Failed to load graph '${graphId}': ${error.message}`);
        }
    });
}
function extractThinkingFromContent(content) {
    const thinkingRegex = /<think>([\s\S]*?)<\/think>/gi;
    let thinking = '';
    let cleanedContent = content;
    let match;
    while ((match = thinkingRegex.exec(content)) !== null) {
        thinking += match[1].trim() + '\n';
    }
    cleanedContent = content.replace(thinkingRegex, '').trim();
    return { thinking: thinking.trim(), cleanedContent };
}
// =============================================================================
// Initial State Builder
// =============================================================================
function buildInitialState(red, input, options, userSettings, runId, publisher) {
    var _a, _b;
    const message = input.message || '';
    const systemPrompt = process.env.SYSTEM_PROMPT ||
        `You are Red, an AI assistant developed by redbtn.io.
Current date: ${new Date().toLocaleDateString()}
Device: ${((_a = options.source) === null || _a === void 0 ? void 0 : _a.device) || 'unknown'}
Application: ${((_b = options.source) === null || _b === void 0 ? void 0 : _b.application) || 'unknown'}

CRITICAL RULES:
1. NEVER mention "knowledge cutoff", "training data", "as of my knowledge", or any limitations
2. NEVER introduce yourself unless this is the FIRST message in a new conversation or you're asked to do so
3. NEVER add disclaimers like "please note" or "for the most up-to-date information"
4. NEVER repeat or rephrase the user's question in your response - just answer it directly
5. NEVER say things like "searching for...", "looking up...", or mention what search query was used
6. If you have search results, use them directly and confidently
7. Be concise and helpful - answer the question directly without extra explanations`;
    const now = new Date();
    let connectionManager;
    if (options.connectionFetcher) {
        connectionManager = new connections_1.ConnectionManager({
            userId: options.userId,
            fetchConnection: options.connectionFetcher.fetchConnection,
            fetchDefaultConnection: options.connectionFetcher.fetchDefaultConnection,
            refreshConnection: options.connectionFetcher.refreshConnection,
        });
    }
    return {
        neuronRegistry: red.neuronRegistry,
        memory: red.memory,
        messageQueue: red.messageQueue,
        mcpClient: {
            callTool: (toolName, args, meta) => red.callMcpTool(toolName, args, meta),
        },
        connectionManager,
        runPublisher: publisher,
        data: {
            query: { message },
            input,
            options: Object.assign(Object.assign({}, options), { runId }),
            runId,
            conversationId: options.conversationId,
            messages: message ? [{ role: 'user', content: message }] : [],
            userId: options.userId,
            accountTier: userSettings.accountTier,
            defaultNeuronId: userSettings.defaultNeuronId,
            defaultWorkerNeuronId: userSettings.defaultWorkerNeuronId,
            systemMessage: systemPrompt,
            currentDateISO: now.toISOString(),
            currentDate: now.toLocaleDateString(),
            currentDateTime: now.toLocaleString(),
        },
    };
}
// =============================================================================
// Non-Streaming Execution
// =============================================================================
function executeNonStreaming(_red, compiledGraph, initialState, publisher, userSettings) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const runId = publisher.id;
        try {
            const invokeConfig = { configurable: { thread_id: runId } };
            const result = yield compiledGraph.graph.invoke(initialState, invokeConfig);
            const rawResponse = ((_a = result.data) === null || _a === void 0 ? void 0 : _a.response) || result.response;
            const responseContent = rawResponse === undefined
                ? ''
                : typeof rawResponse === 'string'
                    ? rawResponse
                    : (rawResponse === null || rawResponse === void 0 ? void 0 : rawResponse.content) || '';
            const { thinking, cleanedContent } = extractThinkingFromContent(responseContent);
            yield publisher.complete({ content: cleanedContent, thinking, data: result.data || {} });
            const state = yield publisher.getState();
            return {
                runId,
                graphId: (state === null || state === void 0 ? void 0 : state.graphId) || '',
                graphName: (state === null || state === void 0 ? void 0 : state.graphName) || '',
                status: 'completed',
                content: cleanedContent,
                thinking,
                data: result.data || {},
                metadata: {
                    startedAt: (state === null || state === void 0 ? void 0 : state.startedAt) || Date.now(),
                    completedAt: (state === null || state === void 0 ? void 0 : state.completedAt) || Date.now(),
                    duration: (state === null || state === void 0 ? void 0 : state.completedAt) ? state.completedAt - state.startedAt : 0,
                    nodesExecuted: (state === null || state === void 0 ? void 0 : state.graph.nodesExecuted) || 0,
                    executionPath: (state === null || state === void 0 ? void 0 : state.graph.executionPath) || [],
                    model: userSettings.defaultNeuronId,
                    tokens: (_b = state === null || state === void 0 ? void 0 : state.metadata) === null || _b === void 0 ? void 0 : _b.tokens,
                },
                graphTrace: {
                    executionPath: (state === null || state === void 0 ? void 0 : state.graph.executionPath) || [],
                    nodeProgress: Object.fromEntries(Object.entries((state === null || state === void 0 ? void 0 : state.graph.nodeProgress) || {}).map(([nodeId, progress]) => [
                        nodeId,
                        { status: progress.status, nodeName: progress.nodeName, nodeType: progress.nodeType, startedAt: progress.startedAt, completedAt: progress.completedAt, error: progress.error },
                    ])),
                    startTime: state === null || state === void 0 ? void 0 : state.startedAt,
                    endTime: state === null || state === void 0 ? void 0 : state.completedAt,
                },
                tools: (state === null || state === void 0 ? void 0 : state.tools) || [],
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            yield publisher.fail(errorMessage);
            const state = yield publisher.getState();
            return {
                runId,
                graphId: (state === null || state === void 0 ? void 0 : state.graphId) || '',
                graphName: (state === null || state === void 0 ? void 0 : state.graphName) || '',
                status: 'error',
                content: '',
                thinking: '',
                data: {},
                error: errorMessage,
                metadata: {
                    startedAt: (state === null || state === void 0 ? void 0 : state.startedAt) || Date.now(),
                    completedAt: Date.now(),
                    duration: (state === null || state === void 0 ? void 0 : state.startedAt) ? Date.now() - state.startedAt : 0,
                    nodesExecuted: (state === null || state === void 0 ? void 0 : state.graph.nodesExecuted) || 0,
                    executionPath: (state === null || state === void 0 ? void 0 : state.graph.executionPath) || [],
                },
                graphTrace: {
                    executionPath: (state === null || state === void 0 ? void 0 : state.graph.executionPath) || [],
                    nodeProgress: Object.fromEntries(Object.entries((state === null || state === void 0 ? void 0 : state.graph.nodeProgress) || {}).map(([nodeId, progress]) => [
                        nodeId,
                        { status: progress.status, nodeName: progress.nodeName, nodeType: progress.nodeType, startedAt: progress.startedAt, completedAt: progress.completedAt, error: progress.error },
                    ])),
                    startTime: state === null || state === void 0 ? void 0 : state.startedAt,
                    endTime: Date.now(),
                },
                tools: (state === null || state === void 0 ? void 0 : state.tools) || [],
            };
        }
    });
}
// =============================================================================
// Streaming Execution
// =============================================================================
function executeStreaming(_red, compiledGraph, initialState, publisher, userSettings) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, e_1, _b, _c;
        var _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
        const runId = publisher.id;
        let fullContent = '';
        let thinkingBuffer = '';
        let inThinkingTag = false;
        let pendingBuffer = '';
        let graphOutputData = null;
        try {
            const streamConfig = { version: 'v1', configurable: { thread_id: runId } };
            const stream = compiledGraph.graph.streamEvents(initialState, streamConfig);
            try {
                for (var _t = true, stream_1 = __asyncValues(stream), stream_1_1; stream_1_1 = yield stream_1.next(), _a = stream_1_1.done, !_a; _t = true) {
                    _c = stream_1_1.value;
                    _t = false;
                    const event = _c;
                    const runName = ((_d = event.metadata) === null || _d === void 0 ? void 0 : _d.langgraph_node) || '';
                    const isRespondNode = runName === 'respond' || runName === 'responder';
                    if (event.event === 'on_llm_stream' && ((_f = (_e = event.data) === null || _e === void 0 ? void 0 : _e.chunk) === null || _f === void 0 ? void 0 : _f.content) && isRespondNode) {
                        const content = event.data.chunk.content;
                        pendingBuffer += content;
                        while (pendingBuffer.length > 8) {
                            if (!inThinkingTag && pendingBuffer.startsWith('<think>')) {
                                inThinkingTag = true;
                                pendingBuffer = pendingBuffer.slice(7);
                                continue;
                            }
                            if (inThinkingTag && pendingBuffer.startsWith('</think>')) {
                                inThinkingTag = false;
                                pendingBuffer = pendingBuffer.slice(8);
                                yield publisher.thinkingComplete();
                                continue;
                            }
                            const char = pendingBuffer[0];
                            pendingBuffer = pendingBuffer.slice(1);
                            if (inThinkingTag) {
                                thinkingBuffer += char;
                                yield publisher.thinkingChunk(char);
                            }
                            else {
                                fullContent += char;
                                yield publisher.chunk(char);
                            }
                        }
                    }
                    if (event.event === 'on_chain_end' && event.name === 'LangGraph') {
                        const graphOutput = (_g = event.data) === null || _g === void 0 ? void 0 : _g.output;
                        // Capture graph output data for the final result
                        if (graphOutput === null || graphOutput === void 0 ? void 0 : graphOutput.data) {
                            graphOutputData = graphOutput.data;
                        }
                        // Try multiple response content locations used by different graph types:
                        // - data.response (standard graphs with responder node)
                        // - data.response.content (wrapped response object)
                        // - data.finding.naturalResponse (claude-assistant workflow graphs)
                        const responseContent = ((_j = (_h = graphOutput === null || graphOutput === void 0 ? void 0 : graphOutput.data) === null || _h === void 0 ? void 0 : _h.response) === null || _j === void 0 ? void 0 : _j.content) ||
                            ((_k = graphOutput === null || graphOutput === void 0 ? void 0 : graphOutput.data) === null || _k === void 0 ? void 0 : _k.response) ||
                            ((_m = (_l = graphOutput === null || graphOutput === void 0 ? void 0 : graphOutput.data) === null || _l === void 0 ? void 0 : _l.finding) === null || _m === void 0 ? void 0 : _m.naturalResponse);
                        // Also check if content was already streamed by the tool parser (via runPublisher.chunk)
                        const alreadyStreamed = (_p = (_o = publisher.getCachedState()) === null || _o === void 0 ? void 0 : _o.output) === null || _p === void 0 ? void 0 : _p.content;
                        if (responseContent && typeof responseContent === 'string' && !fullContent && !alreadyStreamed) {
                            const { thinking, cleanedContent } = extractThinkingFromContent(responseContent);
                            if (thinking) {
                                thinkingBuffer = thinking;
                                for (const char of thinking)
                                    yield publisher.thinkingChunk(char);
                                yield publisher.thinkingComplete();
                            }
                            fullContent = cleanedContent;
                            for (const char of cleanedContent)
                                yield publisher.chunk(char);
                        }
                    }
                }
            }
            catch (e_1_1) { e_1 = { error: e_1_1 }; }
            finally {
                try {
                    if (!_t && !_a && (_b = stream_1.return)) yield _b.call(stream_1);
                }
                finally { if (e_1) throw e_1.error; }
            }
            while (pendingBuffer.length > 0) {
                const char = pendingBuffer[0];
                pendingBuffer = pendingBuffer.slice(1);
                if (inThinkingTag) {
                    thinkingBuffer += char;
                    yield publisher.thinkingChunk(char);
                }
                else {
                    fullContent += char;
                    yield publisher.chunk(char);
                }
            }
            // Use tool-parser-streamed content/thinking if local buffers are empty
            const cachedState = publisher.getCachedState();
            const finalContent = fullContent || ((_q = cachedState === null || cachedState === void 0 ? void 0 : cachedState.output) === null || _q === void 0 ? void 0 : _q.content) || '';
            const finalThinking = thinkingBuffer || ((_r = cachedState === null || cachedState === void 0 ? void 0 : cachedState.output) === null || _r === void 0 ? void 0 : _r.thinking) || '';
            // Use graph output data if available, fall back to initial state data
            const finalData = graphOutputData || initialState.data || {};
            yield publisher.complete({ content: finalContent, thinking: finalThinking, data: finalData });
            const state = yield publisher.getState();
            return {
                runId,
                graphId: (state === null || state === void 0 ? void 0 : state.graphId) || '',
                graphName: (state === null || state === void 0 ? void 0 : state.graphName) || '',
                status: 'completed',
                content: finalContent,
                thinking: finalThinking,
                data: finalData,
                metadata: {
                    startedAt: (state === null || state === void 0 ? void 0 : state.startedAt) || Date.now(),
                    completedAt: (state === null || state === void 0 ? void 0 : state.completedAt) || Date.now(),
                    duration: (state === null || state === void 0 ? void 0 : state.completedAt) ? state.completedAt - state.startedAt : 0,
                    nodesExecuted: (state === null || state === void 0 ? void 0 : state.graph.nodesExecuted) || 0,
                    executionPath: (state === null || state === void 0 ? void 0 : state.graph.executionPath) || [],
                    model: userSettings.defaultNeuronId,
                    tokens: (_s = state === null || state === void 0 ? void 0 : state.metadata) === null || _s === void 0 ? void 0 : _s.tokens,
                },
                graphTrace: {
                    executionPath: (state === null || state === void 0 ? void 0 : state.graph.executionPath) || [],
                    nodeProgress: Object.fromEntries(Object.entries((state === null || state === void 0 ? void 0 : state.graph.nodeProgress) || {}).map(([nodeId, progress]) => [
                        nodeId,
                        { status: progress.status, nodeName: progress.nodeName, nodeType: progress.nodeType, startedAt: progress.startedAt, completedAt: progress.completedAt, error: progress.error },
                    ])),
                    startTime: state === null || state === void 0 ? void 0 : state.startedAt,
                    endTime: state === null || state === void 0 ? void 0 : state.completedAt,
                },
                tools: (state === null || state === void 0 ? void 0 : state.tools) || [],
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            yield publisher.fail(errorMessage);
            const state = yield publisher.getState();
            return {
                runId,
                graphId: (state === null || state === void 0 ? void 0 : state.graphId) || '',
                graphName: (state === null || state === void 0 ? void 0 : state.graphName) || '',
                status: 'error',
                content: fullContent,
                thinking: thinkingBuffer,
                data: {},
                error: errorMessage,
                metadata: {
                    startedAt: (state === null || state === void 0 ? void 0 : state.startedAt) || Date.now(),
                    completedAt: Date.now(),
                    duration: (state === null || state === void 0 ? void 0 : state.startedAt) ? Date.now() - state.startedAt : 0,
                    nodesExecuted: (state === null || state === void 0 ? void 0 : state.graph.nodesExecuted) || 0,
                    executionPath: (state === null || state === void 0 ? void 0 : state.graph.executionPath) || [],
                },
                graphTrace: {
                    executionPath: (state === null || state === void 0 ? void 0 : state.graph.executionPath) || [],
                    nodeProgress: Object.fromEntries(Object.entries((state === null || state === void 0 ? void 0 : state.graph.nodeProgress) || {}).map(([nodeId, progress]) => [
                        nodeId,
                        { status: progress.status, nodeName: progress.nodeName, nodeType: progress.nodeType, startedAt: progress.startedAt, completedAt: progress.completedAt, error: progress.error },
                    ])),
                    startTime: state === null || state === void 0 ? void 0 : state.startedAt,
                    endTime: Date.now(),
                },
                tools: (state === null || state === void 0 ? void 0 : state.tools) || [],
            };
        }
    });
}
// =============================================================================
// Main Entry Point
// =============================================================================
function run(red, input, options) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const { userId } = options;
        if (!userId)
            throw new Error('[run] userId is required');
        const runId = options.runId || generateRunId();
        const stream = (_a = options.stream) !== null && _a !== void 0 ? _a : true;
        console.log(`[run] Starting run ${runId} for user ${userId}`);
        const userSettings = yield loadUserSettings(userId);
        const graphId = options.graphId || userSettings.defaultGraphId;
        const { compiledGraph, graphId: actualGraphId, graphName } = yield loadGraph(red, graphId, userId);
        console.log(`[run] Using graph: ${actualGraphId} (${graphName})`);
        const redis = red.redis;
        if (!redis)
            throw new Error('[run] Redis client not available');
        const lockKey = options.conversationId || runId;
        const runLock = new run_1.RunLock(redis);
        const lock = yield runLock.acquire(lockKey);
        if (!lock)
            throw new Error(`[run] Conversation ${lockKey} already has an active run`);
        console.log(`[run] Acquired lock for conversation ${lockKey}`);
        const publisher = (0, run_1.createRunPublisher)({ redis, runId, userId, log: red.redlog });
        console.log(`[run] ${new Date().toISOString()} Calling publisher.init() for run ${runId}`);
        yield publisher.init(actualGraphId, graphName, input, options.conversationId);
        console.log(`[run] ${new Date().toISOString()} publisher.init() complete for run ${runId}`);
        // Check for existing checkpoint (crash recovery)
        try {
            const checkpointer = (0, MongoCheckpointer_1.createMongoCheckpointer)();
            const existingCheckpoint = yield checkpointer.getTuple({ configurable: { thread_id: runId } });
            if (existingCheckpoint) {
                const step = (_b = existingCheckpoint.metadata) === null || _b === void 0 ? void 0 : _b.step;
                const source = (_c = existingCheckpoint.metadata) === null || _c === void 0 ? void 0 : _c.source;
                console.log(`[run] Crash recovery: found checkpoint for run ${runId} (step=${step}, source=${source}) — resuming from last completed node`);
                yield publisher.publish({
                    type: 'run_resuming',
                    runId,
                    checkpointStep: step,
                    checkpointSource: source,
                    message: 'Resuming from last checkpoint after crash/retry',
                    timestamp: Date.now(),
                });
            }
        }
        catch (checkpointErr) {
            console.warn('[run] Could not check for existing checkpoint:', checkpointErr);
        }
        const initialState = buildInitialState(red, input, options, userSettings, runId, publisher);
        const nodeCount = ((_e = (_d = compiledGraph.config) === null || _d === void 0 ? void 0 : _d.nodes) === null || _e === void 0 ? void 0 : _e.length) || 0;
        const entryNodeId = ((_h = (_g = (_f = compiledGraph.config) === null || _f === void 0 ? void 0 : _f.nodes) === null || _g === void 0 ? void 0 : _g[0]) === null || _h === void 0 ? void 0 : _h.id) || 'entry';
        console.log(`[run] ${new Date().toISOString()} Publishing graph_start for run ${runId}`);
        yield publisher.graphStart(nodeCount, entryNodeId);
        const cleanup = () => __awaiter(this, void 0, void 0, function* () {
            yield lock.release();
            console.log(`[run] Released lock for conversation ${lockKey}`);
        });
        if (stream) {
            const completion = (() => __awaiter(this, void 0, void 0, function* () {
                try {
                    console.log(`[run] ${new Date().toISOString()} Starting execution for run ${runId}`);
                    return yield executeStreaming(red, compiledGraph, initialState, publisher, userSettings);
                }
                finally {
                    yield cleanup();
                }
            }))();
            return { runId, publisher, completion };
        }
        else {
            try {
                return yield executeNonStreaming(red, compiledGraph, initialState, publisher, userSettings);
            }
            finally {
                yield cleanup();
            }
        }
    });
}
// =============================================================================
// Helper: Check if result is streaming
// =============================================================================
function isStreamingResult(result) {
    return 'publisher' in result && 'completion' in result;
}
