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
exports.responderNode = void 0;
const messages_1 = require("@langchain/core/messages");
const thinking_1 = require("../utils/thinking");
const retry_1 = require("../utils/retry");
const node_helpers_1 = require("../utils/node-helpers");
const responderNode = (state) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, e_1, _b, _c;
    var _d, _e, _f;
    try {
        const redInstance = state.redInstance;
        const query = state.query;
        const options = state.options || {};
        const conversationId = options.conversationId;
        const generationId = options.generationId;
        const messageId = state.messageId;
        // Check if a node already generated the final response
        if (state.finalResponse) {
            yield redInstance.logger.log({
                level: 'info',
                category: 'responder',
                message: `<cyan>💬 Using pre-generated response (${state.finalResponse.length} chars)</cyan>`,
                generationId,
                conversationId,
            });
            // Return as AIMessage for consistency
            return {
                response: new messages_1.AIMessage({
                    content: state.finalResponse
                })
            };
        }
        // Check if router passed through a direct response (legacy)
        if (state.directResponse) {
            const directText = state.directResponse;
            yield redInstance.logger.log({
                level: 'info',
                category: 'responder',
                message: `<cyan>💬 Streaming direct response from router (${directText.length} chars)</cyan>`,
                generationId,
                conversationId,
            });
            // Return as AIMessage for consistency
            return {
                response: new messages_1.AIMessage({
                    content: directText
                })
            };
        }
        // Publish status to frontend
        if (messageId) {
            yield redInstance.messageQueue.publishStatus(messageId, {
                action: 'thinking',
                description: 'Generating response'
            });
        }
        // Log responder start
        yield redInstance.logger.log({
            level: 'info',
            category: 'responder',
            message: `<cyan>💬 Generating response...</cyan>`,
            generationId,
            conversationId,
        });
        // Use the base chat model without tools
        const modelWithTools = redInstance.chatModel;
        // Build messages array
        let messages = [];
        // Check if messages were already built by a tool node
        if (state.messages && state.messages.length > 0) {
            messages = [...state.messages];
        }
        else {
            // Build messages from scratch using contextMessages from router
            const initialMessages = [];
            // Add system message (from state or default)
            // Note: Router is node 1, so responder is at least node 2 (or higher after tool nodes)
            const nodeNumber = state.nodeNumber || 2;
            const systemMessage = state.systemMessage || `${(0, node_helpers_1.getNodeSystemPrefix)(nodeNumber, 'Responder')}

You are Red, an AI assistant developed by redbtn.io.

CRITICAL RULES:
1. NEVER mention "knowledge cutoff", "training data", "as of my knowledge", or any limitations
2. NEVER introduce yourself unless this is the FIRST message in a new conversation or you're asked to do so
3. NEVER add disclaimers like "please note" or "for the most up-to-date information"
4. Be direct, helpful, and conversational`;
            initialMessages.push({ role: 'system', content: systemMessage });
            // Use pre-loaded context from router (already loaded once)
            if (state.contextMessages && state.contextMessages.length > 0) {
                console.log('[Responder] contextMessages received:', state.contextMessages.length);
                console.log('[Responder] contextMessages sample:', JSON.stringify(state.contextMessages.slice(0, 3).map(m => { var _a; return ({ role: m.role, contentLen: (_a = m.content) === null || _a === void 0 ? void 0 : _a.length }); }), null, 2));
                // Filter out the CURRENT user message (it will be added separately)
                const filteredMessages = state.contextMessages.filter((msg) => !(msg.role === 'user' && msg.content === query.message));
                initialMessages.push(...filteredMessages);
            }
            messages = initialMessages;
            // Add the current user query
            if (query && query.message) {
                messages.push({
                    role: 'user',
                    content: query.message
                });
            }
        }
        // DEBUG: Check for duplicate messages in the array
        console.log('[Responder] FULL MESSAGES ARRAY BEFORE LLM:');
        messages.forEach((msg, i) => {
            var _a;
            console.log(`  [${i}] role=${msg.role}, content=${(_a = msg.content) === null || _a === void 0 ? void 0 : _a.substring(0, 80)}...`);
        });
        const messageCounts = new Map();
        messages.forEach(msg => {
            var _a;
            const key = `${msg.role}:${(_a = msg.content) === null || _a === void 0 ? void 0 : _a.substring(0, 100)}`;
            messageCounts.set(key, (messageCounts.get(key) || 0) + 1);
        });
        const duplicates = Array.from(messageCounts.entries()).filter(([_, count]) => count > 1);
        if (duplicates.length > 0) {
            console.error('[Responder] DUPLICATE MESSAGES DETECTED:', duplicates.map(([key, count]) => ({ key, count })));
        }
        const maxStreamAttempts = 3;
        for (let attempt = 1; attempt <= maxStreamAttempts; attempt++) {
            try {
                const stream = yield modelWithTools.stream(messages);
                let fullContent = '';
                let usage_metadata = null;
                let response_metadata = null;
                try {
                    for (var _g = true, stream_1 = (e_1 = void 0, __asyncValues(stream)), stream_1_1; stream_1_1 = yield stream_1.next(), _a = stream_1_1.done, !_a; _g = true) {
                        _c = stream_1_1.value;
                        _g = false;
                        const chunk = _c;
                        if (chunk.content) {
                            fullContent += chunk.content;
                        }
                        if (chunk.usage_metadata) {
                            usage_metadata = chunk.usage_metadata;
                        }
                        if (chunk.response_metadata) {
                            response_metadata = chunk.response_metadata;
                        }
                    }
                }
                catch (e_1_1) { e_1 = { error: e_1_1 }; }
                finally {
                    try {
                        if (!_g && !_a && (_b = stream_1.return)) yield _b.call(stream_1);
                    }
                    finally { if (e_1) throw e_1.error; }
                }
                const { thinking, cleanedContent } = (0, thinking_1.extractThinking)(fullContent);
                const aiMessage = new messages_1.AIMessage({
                    content: cleanedContent,
                    usage_metadata,
                    response_metadata,
                });
                // Check if using planner and if response is inadequate (trigger replan)
                const executionPlan = state.executionPlan;
                const replannedCount = state.replannedCount || 0;
                const MAX_REPLANS = 3;
                if (executionPlan && replannedCount < MAX_REPLANS) {
                    // Detect if response is a non-answer (common patterns)
                    const responseText = cleanedContent.toLowerCase();
                    const nonAnswerPatterns = [
                        "i don't have access to real-time",
                        "i cannot access real-time",
                        "i don't have access to current",
                        "i cannot provide real-time",
                        "i don't have the ability to",
                        "i cannot browse",
                        "my training data",
                        "knowledge cutoff",
                        "i'm not able to access",
                        "i don't have information about",
                        "i cannot check",
                        "i'm unable to provide current"
                    ];
                    const isNonAnswer = nonAnswerPatterns.some(pattern => responseText.includes(pattern));
                    // Also check if response is suspiciously short (< 50 chars) and doesn't answer the question
                    const isTooShort = cleanedContent.length < 50;
                    const userQuery = ((_e = (_d = state.query) === null || _d === void 0 ? void 0 : _d.message) === null || _e === void 0 ? void 0 : _e.toLowerCase()) || '';
                    const isQuestion = userQuery.includes('?') || userQuery.includes('what') ||
                        userQuery.includes('how') || userQuery.includes('when') ||
                        userQuery.includes('where') || userQuery.includes('who');
                    if ((isNonAnswer || (isTooShort && isQuestion)) && replannedCount < MAX_REPLANS) {
                        yield redInstance.logger.log({
                            level: 'warn',
                            category: 'responder',
                            message: `<yellow>⚠ Inadequate response detected (${cleanedContent.length} chars), requesting replan</yellow>`,
                            generationId,
                            conversationId,
                            metadata: {
                                responseLength: cleanedContent.length,
                                isNonAnswer,
                                isTooShort,
                                replannedCount
                            }
                        });
                        // Trigger replanning
                        return {
                            response: aiMessage, // Still return the response for context
                            requestReplan: true,
                            replanReason: isNonAnswer
                                ? 'Response indicated lack of real-time data or inability to answer'
                                : 'Response too brief for the question asked',
                            currentStepIndex: 0, // Reset to start of new plan
                            messages: [
                                ...messages,
                                { role: 'assistant', content: cleanedContent },
                                { role: 'system', content: `Previous response was inadequate. The system will create a new plan to properly answer: "${(_f = state.query) === null || _f === void 0 ? void 0 : _f.message}"` }
                            ]
                        };
                    }
                }
                return { response: aiMessage };
            }
            catch (error) {
                if (!(0, retry_1.isNetworkError)(error) || attempt === maxStreamAttempts) {
                    throw error;
                }
                console.warn(`[Responder] Stream attempt ${attempt} failed due to network error, retrying...`, error);
                yield (0, retry_1.wait)(250 * attempt);
            }
        }
    }
    catch (error) {
        console.error('[Responder] Error in responder node:', error);
        throw error;
    }
});
exports.responderNode = responderNode;
