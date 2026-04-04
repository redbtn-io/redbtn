"use strict";
/**
 * Tool Step Executor
 *
 * Executes MCP tool calls with parameter rendering and retry logic.
 * Supports any registered MCP tool (web_search, scrape_url, run_command, etc.)
 */
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
exports.executeTool = executeTool;
const templateRenderer_1 = require("../templateRenderer");
const errorHandler_1 = require("./errorHandler");
const parserRegistry_1 = require("./parserRegistry");
const parserExecutor_1 = require("./parserExecutor");
const { getNativeRegistry } = require('../../../tools/native-registry.js');
// Debug logging - set to true to enable verbose logs
const DEBUG = false;
/**
 * Normalize tool step config by converting legacy inputMapping format to parameters format
 *
 * Legacy format (UI): { toolName, inputMapping: { field1: value1, ... }, outputField }
 * New format (execution): { toolName, parameters: { field1: value1, ... }, outputField }
 *
 * @param config - Tool step configuration that may use legacy format
 * @returns Normalized config with parameters field
 */
function normalizeToolStepConfig(config) {
    const normalized = Object.assign({}, config);
    // Convert legacy inputMapping to parameters
    if (config.inputMapping && !config.parameters) {
        if (typeof config.inputMapping === 'object' && config.inputMapping !== null) {
            normalized.parameters = config.inputMapping;
        }
        else if (typeof config.inputMapping === 'string' && config.inputMapping.trim()) {
            // Legacy single string format - try to parse as object
            try {
                normalized.parameters = JSON.parse(config.inputMapping);
            }
            catch (_a) {
                // Treat as single parameter value
                normalized.parameters = { value: config.inputMapping };
            }
        }
        else {
            normalized.parameters = {};
        }
    }
    // Ensure parameters is always an object
    if (!normalized.parameters || typeof normalized.parameters !== 'object') {
        normalized.parameters = {};
    }
    return normalized;
}
/**
 * Execute a tool step (with error handling wrapper)
 *
 * @param config - Tool step configuration
 * @param state - Current graph state
 * @returns Partial state with output field set to tool result
 */
function executeTool(config, state) {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('[ToolExecutor] ====== STARTING TOOL EXECUTION ======');
        console.log('[ToolExecutor] ToolName:', config.toolName);
        console.log('[ToolExecutor] OutputField:', config.outputField);
        console.log('[ToolExecutor] Parameters:', JSON.stringify(config.parameters));
        // Normalize legacy config format
        const normalizedConfig = normalizeToolStepConfig(config);
        // If error handling configured (new way), use it
        if (normalizedConfig.errorHandling) {
            return (0, errorHandler_1.executeWithErrorHandling)(() => executeToolInternal(normalizedConfig, state), normalizedConfig.errorHandling, { type: 'tool', field: normalizedConfig.outputField });
        }
        // Otherwise use legacy retry logic (backward compatibility)
        return executeToolInternal(normalizedConfig, state);
    });
}
/**
 * Internal tool execution (actual MCP tool call logic)
 *
 * Flow:
 * 1. Get tool from MCP registry
 * 2. Render parameter templates with current state
 * 3. Call tool with rendered parameters
 * 4. Retry on failure if configured (legacy retryOnError)
 * 5. Return result in specified output field
 *
 * @param config - Tool step configuration
 * @param state - Current graph state (includes accumulated updates from previous steps + infrastructure)
 * @returns Partial state with output field set to tool result
 */
function executeToolInternal(config, state) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
        // Validate required fields
        if (!config.toolName) {
            throw new Error('Tool step missing required field: toolName');
        }
        if (!config.outputField) {
            throw new Error('Tool step missing required field: outputField');
        }
        if (!config.parameters || typeof config.parameters !== 'object') {
            throw new Error(`Tool step "${config.toolName}" missing or invalid parameters object`);
        }
        // Get RunPublisher for tool events (only available in run path)
        const runPublisher = state.runPublisher;
        // Generate unique tool execution ID
        const toolId = `tool_${config.toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // --- streamToConversation support ---
        // When runPublisher exists, parsed chunks route through it (which forwards
        // to conversation stream with runId). This makes tool+parser graphs produce
        // identical events to neuron-based graphs. Standalone ConversationPublisher
        // is only used when there's no RunPublisher (non-run context).
        let convPublisher = null;
        let streamMessageId = null;
        let streamRedis = null;
        const streamTarget = config.streamToConversation;
        const streamFilter = config.streamFilter || 'stdout'; // 'stdout' | 'stderr' | 'all'
        const useRunPublisherForConv = !!(runPublisher && streamTarget);
        if (streamTarget && !useRunPublisherForConv) {
            // Standalone path: no RunPublisher, create our own ConversationPublisher
            try {
                const Redis = require('ioredis');
                const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
                streamRedis = new Redis(redisUrl);
                // Determine target conversationId
                const targetConvId = streamTarget === true
                    ? (((_a = state.data) === null || _a === void 0 ? void 0 : _a.conversationId) || state.conversationId || ((_b = state.options) === null || _b === void 0 ? void 0 : _b.conversationId))
                    : String(streamTarget);
                if (targetConvId) {
                    const { createConversationPublisher } = require('../../../conversation/index.js');
                    convPublisher = createConversationPublisher({
                        redis: streamRedis,
                        conversationId: targetConvId,
                    });
                    streamMessageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    yield convPublisher.startMessage(streamMessageId, 'assistant');
                    console.log(`[ToolExecutor] streamToConversation (standalone) enabled for ${config.toolName} -> conversation ${targetConvId}`);
                }
            }
            catch (err) {
                console.warn('[ToolExecutor] Failed to set up streamToConversation:', err.message);
                convPublisher = null;
                streamMessageId = null;
            }
        }
        else if (useRunPublisherForConv) {
            console.log(`[ToolExecutor] streamToConversation via RunPublisher for ${config.toolName}`);
        }
        // --- Stream parser setup ---
        // Load parser when streamToConversation is set, regardless of publisher type
        let parserExecutor = null;
        if (config.streamParser && streamTarget) {
            try {
                const registry = (0, parserRegistry_1.getParserRegistry)();
                const parserDef = yield registry.getParser(config.streamParser);
                if (parserDef) {
                    parserExecutor = new parserExecutor_1.ParserExecutor(parserDef.config, parserDef.parserConfig);
                    console.log(`[ToolExecutor] Stream parser "${config.streamParser}" loaded for ${config.toolName}`);
                }
                else {
                    console.warn(`[ToolExecutor] Stream parser "${config.streamParser}" not found, using passthrough`);
                }
            }
            catch (err) {
                console.warn('[ToolExecutor] Failed to load stream parser:', err.message);
            }
        }
        // Helper: extract stdout/stderr from tool result for conversation streaming
        function extractStreamContent(serializedResult) {
            if (!serializedResult)
                return '';
            if (typeof serializedResult === 'string')
                return serializedResult;
            // For structured results (e.g. ssh_shell), extract stdout/stderr based on filter
            const stdout = serializedResult.stdout || serializedResult.output || '';
            const stderr = serializedResult.stderr || '';
            if (streamFilter === 'all')
                return [stdout, stderr].filter(Boolean).join('\n');
            if (streamFilter === 'stderr')
                return stderr;
            return stdout; // default: 'stdout'
        }
        // Helper: forward tool result to conversation stream and clean up
        function forwardToConversation(serializedResult) {
            return __awaiter(this, void 0, void 0, function* () {
                if (useRunPublisherForConv) {
                    // RunPublisher path: just flush parser remaining buffer
                    // RunPublisher.complete() handles conversation stream completion
                    if (parserExecutor) {
                        try {
                            const flushOutput = yield parserExecutor.flush();
                            if (flushOutput) {
                                if (typeof flushOutput === 'string') {
                                    yield runPublisher.chunk(flushOutput);
                                }
                                else if (flushOutput && typeof flushOutput === 'object' && flushOutput.content) {
                                    if (flushOutput.thinking) {
                                        yield runPublisher.thinkingChunk(flushOutput.content);
                                    }
                                    else {
                                        yield runPublisher.chunk(flushOutput.content);
                                    }
                                }
                            }
                        }
                        catch (flushErr) {
                            console.warn('[ToolExecutor] Parser flush error:', flushErr.message);
                        }
                    }
                    return; // RunPublisher handles conversation completion via run_complete
                }
                if (!convPublisher || !streamMessageId)
                    return;
                try {
                    if (parserExecutor) {
                        // Parser handled per-chunk streaming -- just flush remaining buffer and complete
                        try {
                            const flushOutput = yield parserExecutor.flush();
                            if (flushOutput) {
                                yield convPublisher.streamChunk(streamMessageId, flushOutput);
                            }
                        }
                        catch (flushErr) {
                            console.warn('[ToolExecutor] Parser flush error:', flushErr.message);
                        }
                        yield convPublisher.completeMessage(streamMessageId);
                    }
                    else {
                        const content = extractStreamContent(serializedResult);
                        if (content) {
                            yield convPublisher.streamChunk(streamMessageId, content);
                        }
                        yield convPublisher.completeMessage(streamMessageId);
                    }
                }
                catch (err) {
                    console.warn('[ToolExecutor] streamToConversation forward failed:', err.message);
                }
                finally {
                    try {
                        if (streamRedis)
                            yield streamRedis.quit();
                    }
                    catch ( /* ignore */_a) { /* ignore */ }
                }
            });
        }
        // Helper: clean up conversation stream resources on error
        function cleanupConversationStream() {
            return __awaiter(this, void 0, void 0, function* () {
                if (!convPublisher || !streamMessageId)
                    return;
                try {
                    yield convPublisher.completeMessage(streamMessageId, '[tool execution failed]');
                }
                catch ( /* ignore */_a) { /* ignore */ }
                finally {
                    try {
                        if (streamRedis)
                            yield streamRedis.quit();
                    }
                    catch ( /* ignore */_b) { /* ignore */ }
                }
            });
        }
        try {
            // Render parameter templates with current state (needed for both native and MCP paths)
            const renderedParams = (0, templateRenderer_1.renderParameters)(config.parameters, state);
            // -------------------------------------------------------------------------
            // Connection credential resolution — when connectionId or providerId is set,
            // resolve user credentials from ConnectionManager and pass to tools
            // -------------------------------------------------------------------------
            let resolvedCredentials = null;
            if (config.connectionId || config.providerId) {
                const connectionManager = state.connectionManager;
                if (connectionManager) {
                    try {
                        const connId = config.connectionId
                            ? (0, templateRenderer_1.renderTemplate)(config.connectionId, state)
                            : undefined;
                        const provId = config.providerId
                            ? (0, templateRenderer_1.renderTemplate)(config.providerId, state)
                            : undefined;
                        let context = null;
                        if (connId) {
                            context = yield connectionManager.getConnection(connId);
                        }
                        else if (provId) {
                            context = yield connectionManager.getDefaultConnection(provId);
                        }
                        if (context) {
                            if (context.connection.status !== 'active') {
                                console.warn(`[ToolExecutor] Connection ${context.connection.connectionId} is not active (status: ${context.connection.status})`);
                            }
                            else {
                                resolvedCredentials = {
                                    type: context.credentials.type,
                                    headers: context.credentials.headers,
                                    providerId: context.provider.providerId,
                                    connectionId: context.connection.connectionId,
                                    accountInfo: context.connection.accountInfo ? {
                                        email: context.connection.accountInfo.email,
                                        name: context.connection.accountInfo.name,
                                        externalId: context.connection.accountInfo.externalId,
                                    } : undefined,
                                };
                                console.log(`[ToolExecutor] Resolved credentials for ${config.toolName} from ${resolvedCredentials.providerId} (${resolvedCredentials.connectionId})`);
                            }
                        }
                        else {
                            console.warn(`[ToolExecutor] No connection found for tool ${config.toolName} (connectionId=${connId}, providerId=${provId})`);
                        }
                    }
                    catch (credErr) {
                        console.warn(`[ToolExecutor] Failed to resolve credentials for ${config.toolName}:`, credErr.message);
                    }
                }
                else {
                    console.warn(`[ToolExecutor] ConnectionManager not available in state, cannot resolve credentials for ${config.toolName}`);
                }
            }
            // -------------------------------------------------------------------------
            // Native tool fast path — check BEFORE MCP to avoid JSON-RPC overhead
            // -------------------------------------------------------------------------
            const nativeRegistry = getNativeRegistry();
            if (nativeRegistry.has(config.toolName)) {
                console.log(`[ToolExecutor] Routing to native tool: ${config.toolName}`);
                if (runPublisher) {
                    yield runPublisher.toolStart(toolId, config.toolName, 'native', { input: renderedParams });
                }
                // Build onChunk callback for real-time stream parsing
                const onChunk = (parserExecutor && (useRunPublisherForConv || (convPublisher && streamMessageId)))
                    ? (chunk, streamType) => {
                        const sf = config.streamFilter || 'stdout';
                        if (sf !== 'all' && sf !== streamType)
                            return;
                        try {
                            parserExecutor.processChunk(chunk, streamType).then((outputs) => {
                                if (outputs && outputs.length > 0) {
                                    for (const output of outputs) {
                                        if (useRunPublisherForConv) {
                                            // Route through RunPublisher → both run stream + conversation stream
                                            if (typeof output === 'string') {
                                                runPublisher.chunk(output).catch((err) => {
                                                    console.warn('[ToolExecutor] onChunk RunPublisher.chunk error:', err.message);
                                                });
                                            }
                                            else if (Array.isArray(output)) {
                                                for (const item of output) {
                                                    if (item && item.content) {
                                                        if (item.thinking) {
                                                            runPublisher.thinkingChunk(item.content).catch((err) => {
                                                                console.warn('[ToolExecutor] onChunk RunPublisher.thinkingChunk error:', err.message);
                                                            });
                                                        }
                                                        else {
                                                            runPublisher.chunk(item.content).catch((err) => {
                                                                console.warn('[ToolExecutor] onChunk RunPublisher.chunk error:', err.message);
                                                            });
                                                        }
                                                    }
                                                }
                                            }
                                            else if (output && typeof output === 'object' && output.content) {
                                                if (output.thinking) {
                                                    runPublisher.thinkingChunk(output.content).catch((err) => {
                                                        console.warn('[ToolExecutor] onChunk RunPublisher.thinkingChunk error:', err.message);
                                                    });
                                                }
                                                else {
                                                    runPublisher.chunk(output.content).catch((err) => {
                                                        console.warn('[ToolExecutor] onChunk RunPublisher.chunk error:', err.message);
                                                    });
                                                }
                                            }
                                        }
                                        else {
                                            // Standalone ConversationPublisher path
                                            if (typeof output === 'string') {
                                                convPublisher.streamChunk(streamMessageId, output, false).catch((err) => {
                                                    console.warn('[ToolExecutor] onChunk streamChunk error:', err.message);
                                                });
                                            }
                                            else if (Array.isArray(output)) {
                                                for (const item of output) {
                                                    if (item && item.content) {
                                                        convPublisher.streamChunk(streamMessageId, item.content, !!item.thinking).catch((err) => {
                                                            console.warn('[ToolExecutor] onChunk streamChunk error:', err.message);
                                                        });
                                                    }
                                                }
                                            }
                                            else if (output && typeof output === 'object' && output.content) {
                                                convPublisher.streamChunk(streamMessageId, output.content, !!output.thinking).catch((err) => {
                                                    console.warn('[ToolExecutor] onChunk streamChunk error:', err.message);
                                                });
                                            }
                                        }
                                    }
                                }
                            }).catch((err) => {
                                console.warn('[ToolExecutor] onChunk processChunk error:', err.message);
                            });
                        }
                        catch (err) {
                            console.warn('[ToolExecutor] onChunk error:', err.message);
                        }
                    }
                    : undefined;
                // Build context for the native tool handler
                const nativeContext = {
                    publisher: runPublisher || null,
                    state,
                    runId: ((_c = state.data) === null || _c === void 0 ? void 0 : _c.runId) || state.runId || null,
                    nodeId: ((_d = state.nodeConfig) === null || _d === void 0 ? void 0 : _d.graphNodeId) || ((_e = state.nodeConfig) === null || _e === void 0 ? void 0 : _e.nodeId) || null,
                    toolId: toolId,
                    abortSignal: ((_f = state._abortController) === null || _f === void 0 ? void 0 : _f.signal) || null,
                    onChunk,
                    credentials: resolvedCredentials,
                };
                // Retry logic — mirrors the MCP path
                const maxNativeRetries = config.retryOnError ? ((_g = config.maxRetries) !== null && _g !== void 0 ? _g : 3) : 0;
                let lastNativeError;
                for (let attempt = 0; attempt <= maxNativeRetries; attempt++) {
                    try {
                        if (attempt > 0) {
                            console.log(`[ToolExecutor] Native tool retry ${attempt}/${maxNativeRetries}: ${config.toolName}`);
                            if (runPublisher) {
                                yield runPublisher.toolProgress(toolId, `retry_${attempt}`, {
                                    progress: attempt / (maxNativeRetries + 1),
                                    data: { attempt, maxRetries: maxNativeRetries }
                                });
                            }
                            yield new Promise(resolve => setTimeout(resolve, attempt * 1000));
                        }
                        const nativeResult = yield nativeRegistry.callTool(config.toolName, renderedParams, nativeContext);
                        // Extract result content using the same logic as the MCP path
                        let extractedNativeResult = nativeResult;
                        if (nativeResult && !nativeResult.isError && nativeResult.content && Array.isArray(nativeResult.content)) {
                            const firstContent = nativeResult.content[0];
                            if ((firstContent === null || firstContent === void 0 ? void 0 : firstContent.type) === 'text' && firstContent.text) {
                                try {
                                    extractedNativeResult = JSON.parse(firstContent.text);
                                }
                                catch (_r) {
                                    extractedNativeResult = firstContent.text;
                                }
                            }
                        }
                        let serializedNativeResult;
                        try {
                            serializedNativeResult = JSON.parse(JSON.stringify(extractedNativeResult));
                        }
                        catch (_s) {
                            serializedNativeResult = String(extractedNativeResult);
                        }
                        if (runPublisher) {
                            const resultLength = typeof serializedNativeResult === 'string'
                                ? serializedNativeResult.length
                                : JSON.stringify(serializedNativeResult).length;
                            yield runPublisher.toolComplete(toolId, serializedNativeResult, {
                                outputField: config.outputField,
                                attempts: attempt + 1,
                                resultLength,
                            });
                        }
                        // Forward native tool result to conversation stream
                        yield forwardToConversation(serializedNativeResult);
                        return { [config.outputField]: serializedNativeResult };
                    }
                    catch (nativeErr) {
                        lastNativeError = nativeErr instanceof Error ? nativeErr : new Error(String(nativeErr));
                        if (attempt >= maxNativeRetries)
                            break;
                    }
                }
                // All retries exhausted
                const nativeErrMsg = (lastNativeError === null || lastNativeError === void 0 ? void 0 : lastNativeError.message) || 'Native tool call failed';
                if (runPublisher) {
                    yield runPublisher.toolError(toolId, nativeErrMsg);
                }
                yield cleanupConversationStream();
                throw lastNativeError || new Error(nativeErrMsg);
            }
            // -------------------------------------------------------------------------
            // MCP path (original logic)
            // -------------------------------------------------------------------------
            // Get MCP client from state (it's the registry)
            const mcpClient = state.mcpClient;
            if (!mcpClient) {
                throw new Error('MCP client not available in state');
            }
            if (DEBUG)
                console.log('[ToolExecutor] Executing tool step', {
                    toolName: config.toolName,
                    outputField: config.outputField
                });
            // Emit tool_start event
            if (runPublisher) {
                yield runPublisher.toolStart(toolId, config.toolName, 'mcp', {
                    input: renderedParams
                });
            }
            // Get metadata for tool execution
            // Note: messageId is in state.data.messageId (set by respond.ts initialState)
            const meta = {
                conversationId: ((_h = state.options) === null || _h === void 0 ? void 0 : _h.conversationId) || ((_k = (_j = state.data) === null || _j === void 0 ? void 0 : _j.options) === null || _k === void 0 ? void 0 : _k.conversationId),
                generationId: ((_l = state.options) === null || _l === void 0 ? void 0 : _l.generationId) || ((_o = (_m = state.data) === null || _m === void 0 ? void 0 : _m.options) === null || _o === void 0 ? void 0 : _o.generationId),
                messageId: state.messageId || ((_p = state.data) === null || _p === void 0 ? void 0 : _p.messageId),
                credentials: resolvedCredentials,
            };
            if (DEBUG)
                console.log('[ToolExecutor] Tool meta for event publishing:', {
                    conversationId: meta.conversationId,
                    messageId: meta.messageId
                });
            // Execute with retry logic
            const maxRetries = config.retryOnError ? ((_q = config.maxRetries) !== null && _q !== void 0 ? _q : 3) : 0;
            let lastError;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    // Emit retry progress if not first attempt
                    if (attempt > 0 && runPublisher) {
                        yield runPublisher.toolProgress(toolId, `retry_${attempt}`, {
                            progress: attempt / (maxRetries + 1),
                            data: { attempt, maxRetries }
                        });
                    }
                    // Call tool via registry (handles server lookup and execution)
                    if (DEBUG)
                        console.log(`[ToolExecutor] Calling mcpClient.callTool: ${config.toolName}`);
                    const result = yield mcpClient.callTool(config.toolName, renderedParams, meta);
                    if (DEBUG)
                        console.log(`[ToolExecutor] mcpClient.callTool returned for ${config.toolName}`);
                    if (DEBUG)
                        console.log('[ToolExecutor] Tool call succeeded', {
                            toolName: config.toolName,
                            outputField: config.outputField,
                            attempt: attempt + 1
                        });
                    // Check if result is serializable BEFORE processing
                    try {
                        JSON.stringify(result);
                    }
                    catch (_t) {
                        console.error('[ToolExecutor] Tool result contains circular references from MCP!', {
                            toolName: config.toolName,
                            resultKeys: Object.keys(result || {})
                        });
                    }
                    // Extract result content (MCP tools return {content: [...], isError: false})
                    let extractedResult = result;
                    if (result && !result.isError && result.content && Array.isArray(result.content)) {
                        // Try to parse JSON content if it's text
                        const firstContent = result.content[0];
                        if ((firstContent === null || firstContent === void 0 ? void 0 : firstContent.type) === 'text' && firstContent.text) {
                            try {
                                extractedResult = JSON.parse(firstContent.text);
                            }
                            catch (_u) {
                                // Not JSON, use raw text
                                extractedResult = firstContent.text;
                            }
                        }
                    }
                    // Ensure result is JSON-serializable (remove circular references, MongoDB objects, etc.)
                    let serializedResult;
                    try {
                        serializedResult = JSON.parse(JSON.stringify(extractedResult));
                    }
                    catch (_v) {
                        console.warn('[ToolExecutor] Result contains circular references, extracting primitive data');
                        // If serialization fails, try to extract only primitive data
                        if (typeof extractedResult === 'string') {
                            serializedResult = extractedResult;
                        }
                        else if (extractedResult && typeof extractedResult === 'object') {
                            // Extract only serializable properties
                            serializedResult = {};
                            for (const key in extractedResult) {
                                try {
                                    const value = extractedResult[key];
                                    // Only include primitives, arrays, and plain objects
                                    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                                        JSON.stringify(value); // Test if serializable
                                        serializedResult[key] = value;
                                    }
                                }
                                catch (_w) {
                                    // Skip non-serializable properties
                                }
                            }
                        }
                        else {
                            serializedResult = String(extractedResult);
                        }
                    }
                    // Emit tool_complete event
                    if (runPublisher) {
                        const resultLength = typeof serializedResult === 'string'
                            ? serializedResult.length
                            : JSON.stringify(serializedResult).length;
                        yield runPublisher.toolComplete(toolId, serializedResult, {
                            outputField: config.outputField,
                            attempts: attempt + 1,
                            resultLength,
                        });
                    }
                    // Forward MCP tool result to conversation stream
                    yield forwardToConversation(serializedResult);
                    // Return output field
                    return {
                        [config.outputField]: serializedResult
                    };
                }
                catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    if (attempt < maxRetries) {
                        // Calculate exponential backoff: 1s, 2s, 3s
                        const delayMs = (attempt + 1) * 1000;
                        console.warn('[ToolExecutor] Tool call failed, retrying', {
                            toolName: config.toolName,
                            attempt: attempt + 1,
                            maxRetries,
                            delayMs,
                            error: lastError.message
                        });
                        yield new Promise(resolve => setTimeout(resolve, delayMs));
                    }
                }
            }
            // All retries exhausted - emit tool_error
            const errorMessage = (lastError === null || lastError === void 0 ? void 0 : lastError.message) || 'Tool call failed';
            if (runPublisher) {
                yield runPublisher.toolError(toolId, errorMessage);
            }
            yield cleanupConversationStream();
            console.error('[ToolExecutor] Tool step failed after retries', {
                toolName: config.toolName,
                outputField: config.outputField,
                attempts: maxRetries + 1,
                error: errorMessage
            });
            throw lastError || new Error('Tool call failed');
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Emit tool_error if not already emitted (for non-retry errors)
            if (runPublisher) {
                yield runPublisher.toolError(toolId, errorMessage);
            }
            yield cleanupConversationStream();
            console.error('[ToolExecutor] Tool step failed', {
                toolName: config.toolName,
                outputField: config.outputField,
                error: errorMessage
            });
            throw new Error(`Tool step failed: ${errorMessage}`);
        }
    });
}
