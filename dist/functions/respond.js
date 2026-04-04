"use strict";
/**
 * Response generation and streaming utilities
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
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
exports.respond = respond;
const red_1 = require("../lib/graphs/red");
const background = __importStar(require("./background"));
/**
 * Handles a direct, on-demand request from a user-facing application.
 * Automatically manages conversation history, memory, and summarization.
 * @param red The Red instance
 * @param query The user's input or request data (must have a 'message' property)
 * @param options Metadata about the source of the request and conversation settings
 * @returns For non-streaming: the full AIMessage object with content, tokens, metadata, and conversationId.
 *          For streaming: an async generator that yields metadata first (with conversationId), then string chunks, then finally the full AIMessage.
 */
function respond(red_2, query_1) {
    return __awaiter(this, arguments, void 0, function* (red, query, options = {}) {
        var _a, _b, _c, _d;
        // Generate conversation ID if not provided (use memory directly for ID generation since it's a simple utility)
        const conversationId = options.conversationId || red.memory.generateConversationId(query.message);
        // Extract messageId for Redis pub/sub (if provided) - this is the request/generation ID
        const requestId = options.messageId;
        // Generate separate message IDs for user and assistant messages
        // Use provided userMessageId from frontend if available, otherwise generate one
        const userMessageId = options.userMessageId || `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const assistantMessageId = `msg_${Date.now() + 1}_${Math.random().toString(36).substring(7)}`;
        console.log(`[Respond] Starting respond() - conversationId:${conversationId}, requestId:${requestId}, userMessageId:${userMessageId}, query:${query.message.substring(0, 50)}`);
        // Start a new generation (will fail if one is already in progress)
        const generationId = yield red.logger.startGeneration(conversationId);
        if (!generationId) {
            yield red.logger.log({
                level: 'warn',
                category: 'system',
                message: 'Generation already in progress for conversation',
                conversationId,
                metadata: { query: query.message.substring(0, 100) }
            });
            throw new Error('A generation is already in progress for this conversation');
        }
        // Log generation start
        yield red.logger.log({
            level: 'info',
            category: 'system',
            message: `<cyan>Starting generation</cyan> <dim>${generationId}</dim>`,
            generationId,
            conversationId,
            metadata: {
                messageId: requestId,
                queryLength: query.message.length,
                source: options.source
            }
        });
        // Store user message via Context MCP
        yield red.callMcpTool('store_message', {
            conversationId,
            role: 'user',
            content: query.message,
            messageId: userMessageId, // Use unique user message ID
            toolExecutions: [] // User messages don't have tool executions
        }, { conversationId, generationId, messageId: requestId });
        const initialState = {
            query,
            options: Object.assign(Object.assign({}, options), { conversationId, generationId }), // Add generationId to options
            redInstance: red, // Pass the entire instance into the graph
            messageId: requestId, // Add requestId to state for tool event publishing
            messages: [{ role: 'user', content: query.message }], // Add initial message for precheck/classifier
        };
        // Inject a system message into the graph state for every respond() call.
        // Use env override if available so this can be configured without code changes.
        const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `You are Red, an AI assistant developed by redbtn.io.
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
        // Attach as `systemMessage` so the responder node can use it
        // Tool nodes may override this with their own system messages
        initialState.systemMessage = SYSTEM_PROMPT;
        // Check if streaming is requested
        if (options.stream) {
            // Use LangGraph's streaming capabilities to stream through the graph
            return streamThroughGraphWithMemory(red, initialState, conversationId, generationId, requestId, assistantMessageId);
        }
        else {
            // Invoke the graph and return the full AIMessage
            const result = yield red_1.redGraph.invoke(initialState);
            const response = result.response;
            // Retrieve tool executions from Redis state
            let toolExecutions = [];
            if (requestId) {
                const messageState = yield red.messageQueue.getMessageState(requestId);
                if (messageState === null || messageState === void 0 ? void 0 : messageState.toolEvents) {
                    // Convert tool events to tool executions for storage
                    const toolMap = new Map();
                    for (const event of messageState.toolEvents) {
                        if (event.type === 'tool_start') {
                            toolMap.set(event.toolId, {
                                toolId: event.toolId,
                                toolType: event.toolType,
                                toolName: event.toolName,
                                status: 'running',
                                startTime: new Date(event.timestamp),
                                steps: [],
                                metadata: event.metadata || {}
                            });
                        }
                        else if (event.type === 'tool_progress' && toolMap.has(event.toolId)) {
                            const tool = toolMap.get(event.toolId);
                            tool.steps.push({
                                step: event.step,
                                timestamp: new Date(event.timestamp),
                                progress: event.progress,
                                data: event.data
                            });
                            if (event.progress !== undefined) {
                                tool.progress = event.progress;
                            }
                            tool.currentStep = event.step;
                        }
                        else if (event.type === 'tool_complete' && toolMap.has(event.toolId)) {
                            const tool = toolMap.get(event.toolId);
                            tool.status = 'completed';
                            tool.endTime = new Date(event.timestamp);
                            tool.duration = tool.endTime.getTime() - tool.startTime.getTime();
                            if (event.result !== undefined) {
                                tool.result = event.result;
                            }
                            if (event.metadata) {
                                tool.metadata = Object.assign(Object.assign({}, tool.metadata), event.metadata);
                            }
                        }
                        else if (event.type === 'tool_error' && toolMap.has(event.toolId)) {
                            const tool = toolMap.get(event.toolId);
                            tool.status = 'error';
                            tool.endTime = new Date(event.timestamp);
                            tool.duration = tool.endTime.getTime() - tool.startTime.getTime();
                            tool.error = typeof event.error === 'string' ? event.error : JSON.stringify(event.error);
                        }
                    }
                    toolExecutions = Array.from(toolMap.values());
                    console.log(`[Respond] Collected ${toolExecutions.length} tool executions from generation state`);
                }
            }
            // Store assistant response via Context MCP
            yield red.callMcpTool('store_message', {
                conversationId,
                role: 'assistant',
                content: typeof response.content === 'string' ? response.content : JSON.stringify(response.content),
                messageId: assistantMessageId, // Use unique assistant message ID
                toolExecutions
            }, { conversationId, generationId, messageId: requestId });
            // Get message count for title generation via Context MCP
            const metadataResult = yield red.callMcpTool('get_conversation_metadata', {
                conversationId
            }, { conversationId, generationId, messageId: requestId });
            const messageCount = metadataResult.isError ? 0 : JSON.parse(((_d = (_c = metadataResult.content) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.text) || '{}').messageCount || 0;
            // Trigger background summarization (non-blocking)
            background.summarizeInBackground(conversationId, red.memory, red.chatModel);
            // Trigger background title generation (non-blocking)
            background.generateTitleInBackground(conversationId, messageCount, red, red.chatModel);
            // Attach conversationId to response for server access
            return Object.assign(Object.assign({}, response), { conversationId });
        }
    });
}
/**
 * Internal method to handle streaming responses through the graph with memory management.
 * Yields metadata first (with conversationId), then string chunks, then the final AIMessage object.
 * Extracts and logs thinking from models like DeepSeek-R1.
 * @private
 */
function streamThroughGraphWithMemory(red, initialState, conversationId, generationId, requestId, assistantMessageId) {
    return __asyncGenerator(this, arguments, function* streamThroughGraphWithMemory_1() {
        var _a, e_1, _b, _c;
        var _d, _e, _f, _g, _h, _j, _k, _l, _m;
        try {
            // Import thinking utilities
            const { extractThinking, logThinking } = yield __await(Promise.resolve().then(() => __importStar(require('../lib/utils/thinking'))));
            // Import tool event system (disabled - not implemented yet)
            // const { createIntegratedPublisher } = await import('../lib/events/integrated-publisher');
            // Create tool event publisher for thinking (if we have a requestId)
            let thinkingPublisher = null;
            // if (requestId) {
            //   thinkingPublisher = createIntegratedPublisher(
            //     red.messageQueue,
            //     'thinking',
            //     'AI Reasoning',
            //     messageId,
            //     conversationId
            //   );
            // }
            // Yield metadata first so server can capture conversationId and generationId immediately
            yield yield __await({ _metadata: true, conversationId, generationId });
            // Note: Initial status is now published by the router node, not here
            // This prevents race conditions where "processing" overwrites "searching"
            // Use LangGraph's streamEvents to get token-level streaming
            const stream = red_1.redGraph.streamEvents(initialState, { version: "v1" });
            let finalMessage = null;
            let fullContent = '';
            let streamedTokens = false;
            let streamedThinking = false; // Track if we streamed any thinking
            let thinkingBuffer = '';
            let inThinkingTag = false;
            let eventCount = 0;
            let toolIndicatorSent = false;
            let pendingBuffer = ''; // Buffer for partial tag detection across chunks
            try {
                for (var _o = true, stream_1 = __asyncValues(stream), stream_1_1; stream_1_1 = yield __await(stream_1.next()), _a = stream_1_1.done, !_a; _o = true) {
                    _c = stream_1_1.value;
                    _o = false;
                    const event = _c;
                    eventCount++;
                    // Note: Tool status is now published by router node directly
                    // No need to detect it here from stream events
                    // Filter out LLM calls from router and toolPicker nodes (classification/tool selection)
                    // Check multiple event properties to identify the source node
                    const eventName = event.name || '';
                    const eventTags = event.tags || [];
                    const runName = ((_d = event.metadata) === null || _d === void 0 ? void 0 : _d.langgraph_node) || '';
                    // CRITICAL: Only stream content from the responder node
                    // All other LLM calls (router, optimizer, search extractors, etc.) are internal
                    // The langgraph_node metadata should be exactly "responder" for the responder node
                    const isResponderNode = runName === 'responder';
                    // Yield streaming content chunks (for models that stream tokens)
                    // But ONLY from the responder node - all other LLM calls are internal
                    if (event.event === "on_llm_stream" && ((_f = (_e = event.data) === null || _e === void 0 ? void 0 : _e.chunk) === null || _f === void 0 ? void 0 : _f.content) && isResponderNode) {
                        let content = event.data.chunk.content;
                        // Add content to pending buffer for tag detection
                        pendingBuffer += content;
                        // Process pending buffer character by character
                        // Keep last 8 chars in buffer in case we get partial tag at chunk boundary
                        while (pendingBuffer.length > 8) {
                            // Check for opening think tag in pending buffer
                            if (!inThinkingTag && pendingBuffer.startsWith('<think>')) {
                                inThinkingTag = true;
                                pendingBuffer = pendingBuffer.slice(7); // Remove '<think>'
                                console.log('[Respond] 🧠 THINKING TAG OPENED | Next chars:', pendingBuffer.substring(0, 50));
                                // Publish tool start event
                                if (thinkingPublisher) {
                                    yield __await(thinkingPublisher.publishStart({
                                        model: red.chatModel.model,
                                    }));
                                }
                                // Emit status that thinking is starting (legacy)
                                if (requestId) {
                                    yield __await(red.messageQueue.publishStatus(requestId, {
                                        action: 'thinking',
                                        description: 'Reasoning through the problem'
                                    }));
                                    yield yield __await({ _status: true, action: 'thinking', description: 'Reasoning through the problem' });
                                    process.stdout.write(`[Respond] Streaming thinking: 0 chars\r`);
                                }
                                continue; // Recheck buffer after removing tag
                            }
                            // Check for closing think tag
                            if (inThinkingTag && pendingBuffer.startsWith('</think>')) {
                                console.log('[Respond] 🧠 THINKING TAG CLOSED - accumulated', thinkingBuffer.length, 'chars');
                                if (requestId) {
                                    process.stdout.write(`\n[Respond] Thinking complete: ${thinkingBuffer.length} chars\n`);
                                }
                                inThinkingTag = false;
                                pendingBuffer = pendingBuffer.slice(8); // Remove '</think>'
                                // ✨ IMPORTANT: Send a space character immediately to trigger thinking shrink
                                // This ensures frontend gets a content chunk even if whitespace follows
                                console.log('[Respond] 📤 Sending content chunk to trigger thinking shrink');
                                streamedTokens = true;
                                yield yield __await(' ');
                                // Log the accumulated thinking
                                if (thinkingBuffer.trim()) {
                                    logThinking(thinkingBuffer.trim(), 'Chat (Streaming)');
                                    // Publish tool complete event
                                    if (thinkingPublisher) {
                                        yield __await(thinkingPublisher.publishComplete({ reasoning: thinkingBuffer.trim() }, {
                                            characterCount: thinkingBuffer.length,
                                            model: red.chatModel.model,
                                        }));
                                    }
                                    // Store thinking separately in database
                                    if (generationId && conversationId) {
                                        const thinkingContent = thinkingBuffer.trim();
                                        try {
                                            const db = yield __await(Promise.resolve().then(() => __importStar(require('../lib/memory/database'))).then(m => m.getDatabase()));
                                            const thoughtId = yield __await(db.storeThought({
                                                thoughtId: `thought_${generationId}_${Date.now()}`,
                                                messageId: requestId, // Use requestId for thinking link
                                                conversationId,
                                                generationId,
                                                source: 'chat',
                                                content: thinkingContent,
                                                timestamp: new Date(),
                                                metadata: {
                                                    streamChunk: true,
                                                },
                                            }));
                                        }
                                        catch (err) {
                                            console.error('[Respond] Failed to store streaming thinking:', err);
                                        }
                                    }
                                }
                                thinkingBuffer = '';
                                continue; // Recheck buffer after removing tag
                            }
                            // Process one character from buffer
                            const char = pendingBuffer[0];
                            pendingBuffer = pendingBuffer.slice(1);
                            // Accumulate thinking or stream regular content
                            if (inThinkingTag) {
                                thinkingBuffer += char;
                                // Publish streaming content via tool event system
                                if (thinkingPublisher) {
                                    yield __await(thinkingPublisher.publishStreamingContent(char));
                                }
                                // Stream thinking character-by-character via Redis pub/sub
                                if (requestId) {
                                    // Publish thinking chunk to Redis for real-time streaming
                                    yield __await(red.messageQueue.publishThinkingChunk(requestId, char));
                                    // Track that we've streamed thinking
                                    streamedThinking = true;
                                    // Update progress indicator without logging each character
                                    if (thinkingBuffer.length % 100 === 0) {
                                        process.stdout.write(`[Respond] Streaming thinking: ${thinkingBuffer.length} chars\r`);
                                    }
                                    yield yield __await({ _thinkingChunk: true, content: char });
                                }
                            }
                            else {
                                // Skip leading whitespace at the start of content
                                if (!streamedTokens && (char === '\n' || char === '\r' || char === ' ')) {
                                    continue;
                                }
                                // Log first content character after thinking ends
                                if (streamedThinking && !streamedTokens) {
                                    console.log('[Respond] 📝 FIRST CONTENT CHARACTER after thinking:', JSON.stringify(char));
                                }
                                fullContent += char;
                                streamedTokens = true;
                                yield yield __await(char); // Only stream non-thinking content
                            }
                        }
                    }
                    // Capture the final message when LLM completes - use on_llm_end
                    // Only from responder node
                    if (event.event === "on_llm_end" && isResponderNode) {
                        // The AIMessage is nested in the generations array
                        const generations = (_h = (_g = event.data) === null || _g === void 0 ? void 0 : _g.output) === null || _h === void 0 ? void 0 : _h.generations;
                        if (generations && generations[0] && ((_j = generations[0][0]) === null || _j === void 0 ? void 0 : _j.message)) {
                            finalMessage = generations[0][0].message;
                        }
                    }
                }
            }
            catch (e_1_1) { e_1 = { error: e_1_1 }; }
            finally {
                try {
                    if (!_o && !_a && (_b = stream_1.return)) yield __await(_b.call(stream_1));
                }
                finally { if (e_1) throw e_1.error; }
            }
            // CRITICAL: Flush remaining pending buffer (last 8 chars or less)
            if (pendingBuffer.length > 0) {
                process.stdout.write(`\r[Respond] Flushing ${pendingBuffer.length} remaining chars\n`);
            }
            while (pendingBuffer.length > 0) {
                const char = pendingBuffer[0];
                pendingBuffer = pendingBuffer.slice(1);
                if (inThinkingTag) {
                    thinkingBuffer += char;
                    if (requestId) {
                        yield __await(red.messageQueue.publishThinkingChunk(requestId, char));
                        streamedThinking = true;
                        yield yield __await({ _thinkingChunk: true, content: char });
                    }
                }
                else {
                    // Skip leading whitespace at the start of content
                    if (!streamedTokens && (char === '\n' || char === '\r' || char === ' ')) {
                        continue;
                    }
                    fullContent += char;
                    streamedTokens = true;
                    yield yield __await(char);
                }
            }
            // If there's remaining thinking content at the end, log it
            if (thinkingBuffer.trim()) {
                logThinking(thinkingBuffer.trim(), 'Chat (Streaming)');
            }
            // If no tokens were streamed (e.g., when using tool calls like 'speak'),
            // get the final content and stream it character by character
            // BUT: Don't run this if we already streamed thinking, to avoid duplicate thinking events
            if (!streamedTokens && !streamedThinking && finalMessage && finalMessage.content) {
                // Extract thinking for logging (console)
                const { thinking, cleanedContent } = extractThinking(finalMessage.content);
                if (thinking) {
                    logThinking(thinking, 'Chat (Non-streamed)');
                    // Store thinking separately in database
                    if (generationId && conversationId) {
                        try {
                            const db = yield __await(Promise.resolve().then(() => __importStar(require('../lib/memory/database'))).then(m => m.getDatabase()));
                            const thoughtId = yield __await(db.storeThought({
                                thoughtId: `thought_${generationId}`,
                                messageId: requestId, // Use requestId for thinking link
                                conversationId,
                                generationId,
                                source: 'chat',
                                content: thinking,
                                timestamp: new Date(),
                                metadata: {
                                    model: red.chatModel.model,
                                },
                            }));
                            console.log(`[Respond] Stored thinking: ${thoughtId} with messageId: ${requestId}`);
                            // Publish to Redis for real-time updates  
                            if (requestId) {
                                console.log(`[Respond] Publishing non-stream thinking to Redis for messageId: ${requestId}, length: ${thinking.length}`);
                                // Publish thinking content chunk by chunk for consistent display
                                for (const char of thinking) {
                                    yield __await(red.messageQueue.publishThinkingChunk(requestId, char));
                                }
                                console.log(`[Respond] Published non-stream thinking successfully`);
                            }
                            else {
                                console.warn(`[Respond] No messageId provided for non-stream thinking`);
                            }
                        }
                        catch (err) {
                            console.error('[Respond] Failed to store non-streamed thinking:', err);
                        }
                    }
                }
                // Use CLEANED content (thinking will be stored separately)
                fullContent = cleanedContent;
                // Stream the cleaned content for UX
                const words = cleanedContent.split(' ');
                for (let i = 0; i < words.length; i++) {
                    const word = words[i];
                    yield yield __await(i === 0 ? word : ' ' + word);
                    // Small delay for smooth streaming effect (optional)
                    yield __await(new Promise(resolve => setTimeout(resolve, 20)));
                }
            }
            // Store assistant response via Context MCP (after streaming completes)
            if (fullContent) {
                // Retrieve tool executions from Redis state
                let toolExecutions = [];
                if (requestId) {
                    const messageState = yield __await(red.messageQueue.getMessageState(requestId));
                    console.log(`[Respond] Message state for ${requestId}:`, messageState ? 'Found' : 'Not found');
                    console.log(`[Respond] Tool events in state:`, ((_k = messageState === null || messageState === void 0 ? void 0 : messageState.toolEvents) === null || _k === void 0 ? void 0 : _k.length) || 0);
                    if (messageState === null || messageState === void 0 ? void 0 : messageState.toolEvents) {
                        // Convert tool events to tool executions for storage
                        const toolMap = new Map();
                        for (const event of messageState.toolEvents) {
                            if (event.type === 'tool_start') {
                                toolMap.set(event.toolId, {
                                    toolId: event.toolId,
                                    toolType: event.toolType,
                                    toolName: event.toolName,
                                    status: 'running',
                                    startTime: new Date(event.timestamp),
                                    steps: [],
                                    metadata: event.metadata || {}
                                });
                            }
                            else if (event.type === 'tool_progress' && toolMap.has(event.toolId)) {
                                const tool = toolMap.get(event.toolId);
                                tool.steps.push({
                                    step: event.step,
                                    timestamp: new Date(event.timestamp),
                                    progress: event.progress,
                                    data: event.data
                                });
                                if (event.progress !== undefined) {
                                    tool.progress = event.progress;
                                }
                                tool.currentStep = event.step;
                            }
                            else if (event.type === 'tool_complete' && toolMap.has(event.toolId)) {
                                const tool = toolMap.get(event.toolId);
                                tool.status = 'completed';
                                tool.endTime = new Date(event.timestamp);
                                tool.duration = tool.endTime.getTime() - tool.startTime.getTime();
                                if (event.result !== undefined) {
                                    tool.result = event.result;
                                }
                                if (event.metadata) {
                                    tool.metadata = Object.assign(Object.assign({}, tool.metadata), event.metadata);
                                }
                            }
                            else if (event.type === 'tool_error' && toolMap.has(event.toolId)) {
                                const tool = toolMap.get(event.toolId);
                                tool.status = 'error';
                                tool.endTime = new Date(event.timestamp);
                                tool.duration = tool.endTime.getTime() - tool.startTime.getTime();
                                tool.error = typeof event.error === 'string' ? event.error : JSON.stringify(event.error);
                            }
                        }
                        toolExecutions = Array.from(toolMap.values());
                        console.log(`[Respond] Collected ${toolExecutions.length} tool executions from generation state`);
                    }
                    else {
                        console.log(`[Respond] No tool events found in message state`);
                    }
                }
                else {
                    console.log(`[Respond] No requestId provided, cannot retrieve tool executions`);
                }
                console.log(`[Respond] About to store message with ${toolExecutions.length} tool executions`);
                // Store content via MCP for LLM context (already cleaned in streaming/non-streaming paths)
                yield __await(red.callMcpTool('store_message', {
                    conversationId,
                    role: 'assistant',
                    content: fullContent,
                    messageId: assistantMessageId, // Use unique assistant message ID
                    toolExecutions
                }, { conversationId, generationId, messageId: requestId }));
                // Complete the generation
                yield __await(red.logger.completeGeneration(generationId, {
                    response: fullContent,
                    thinking: thinkingBuffer || undefined,
                    route: initialState.toolAction || 'chat',
                    toolsUsed: initialState.selectedTools,
                    model: red.chatModel.model,
                    tokens: finalMessage === null || finalMessage === void 0 ? void 0 : finalMessage.usage_metadata,
                }));
                // Get message count for title generation via Context MCP
                const metadataResult = yield __await(red.callMcpTool('get_conversation_metadata', {
                    conversationId
                }, { conversationId, generationId, messageId: requestId }));
                const messageCount = metadataResult.isError ? 0 : JSON.parse(((_m = (_l = metadataResult.content) === null || _l === void 0 ? void 0 : _l[0]) === null || _m === void 0 ? void 0 : _m.text) || '{}').messageCount || 0;
                // Trigger background summarization (non-blocking)
                background.summarizeInBackground(conversationId, red.memory, red.chatModel);
                // Trigger background title generation (non-blocking)
                background.generateTitleInBackground(conversationId, messageCount, red, red.chatModel);
                // Trigger executive summary generation after 3rd+ message (non-blocking)
                if (messageCount >= 3) {
                    background.generateExecutiveSummaryInBackground(conversationId, red.memory, red.chatModel);
                }
            }
            // After all chunks are sent, yield the final AIMessage with complete token data
            if (finalMessage) {
                yield yield __await(finalMessage);
            }
        }
        catch (error) {
            // Log the failure and mark generation as failed
            yield __await(red.logger.failGeneration(generationId, error instanceof Error ? error.message : String(error)));
            throw error; // Re-throw to propagate the error
        }
    });
}
