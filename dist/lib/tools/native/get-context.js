"use strict";
/**
 * Get Context — Native Context Tool
 *
 * Builds formatted conversation context for LLM consumption.
 * Automatically manages token limits, includes summaries, and formats
 * messages. Produces identical results to the MCP context-sse.ts
 * `get_context_history` handler.
 *
 * Ported from: src/lib/mcp/servers/context-sse.ts → get_context_history
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
const memory_1 = require("../../memory/memory");
let _memoryManager = null;
function getMemoryManager() {
    if (!_memoryManager) {
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
        _memoryManager = new memory_1.MemoryManager(redisUrl);
    }
    return _memoryManager;
}
const getContext = {
    description: 'Build formatted conversation context for LLM consumption. Automatically manages token limits, includes summaries, and formats messages.',
    server: 'context',
    inputSchema: {
        type: 'object',
        properties: {
            conversationId: {
                type: 'string',
                description: 'The conversation ID to build context for',
            },
            maxTokens: {
                type: 'number',
                description: 'Maximum tokens for recent messages (default: 30000)',
                default: 30000,
            },
            includeSystemPrompt: {
                type: 'boolean',
                description: 'Include system prompt in formatted output',
                default: false,
            },
            systemPromptText: {
                type: 'string',
                description: 'Custom system prompt to prepend',
            },
            includeSummary: {
                type: 'boolean',
                description: 'Include conversation summary if available',
                default: true,
            },
            summaryType: {
                type: 'string',
                enum: ['trailing', 'executive', 'both'],
                description: 'Type of summary to include: trailing (old messages), executive (overview), or both',
                default: 'trailing',
            },
            format: {
                type: 'string',
                enum: ['raw', 'formatted', 'llm'],
                description: 'Output format: raw (objects), formatted (text), llm (ready for model)',
                default: 'llm',
            },
        },
        required: ['conversationId'],
    },
    handler: (rawArgs, context) => __awaiter(void 0, void 0, void 0, function* () {
        const args = rawArgs;
        const { conversationId, includeSummary = true, summaryType = 'trailing', format = 'llm', includeSystemPrompt = false, systemPromptText, } = args;
        const publisher = (context === null || context === void 0 ? void 0 : context.publisher) || null;
        const nodeId = (context === null || context === void 0 ? void 0 : context.nodeId) || 'get_context';
        const startTime = Date.now();
        console.log(`[get_context] Building context for ${conversationId}, format=${format}`);
        try {
            const mm = getMemoryManager();
            // Fetch summary if requested
            let trailingSummary = null;
            let executiveSummary = null;
            if (includeSummary) {
                if (summaryType === 'trailing' || summaryType === 'both') {
                    trailingSummary = yield mm.getTrailingSummary(conversationId);
                }
                if (summaryType === 'executive' || summaryType === 'both') {
                    executiveSummary = yield mm.getExecutiveSummary(conversationId);
                }
            }
            // Fetch recent messages within token limit
            const recentMessages = yield mm.getContextForConversation(conversationId);
            // Estimate total tokens (rough: 1 token ~ 4 chars)
            let totalTokens = 0;
            for (const msg of recentMessages) {
                totalTokens += Math.ceil((msg.role.length + msg.content.length) / 4) + 4;
            }
            const duration = Date.now() - startTime;
            console.log(`[get_context] Built context: ${recentMessages.length} messages, ~${totalTokens} tokens in ${duration}ms`);
            // Stream progress via RunPublisher
            if (publisher) {
                try {
                    publisher.publish({
                        type: 'tool_output',
                        nodeId,
                        data: {
                            chunk: `[get_context] ${recentMessages.length} messages, ~${totalTokens} tokens (${duration}ms)\n`,
                            stream: 'stdout',
                        },
                    });
                }
                catch (_) { /* ignore */ }
            }
            // Format output based on requested format
            if (format === 'raw') {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                conversationId,
                                trailingSummary,
                                executiveSummary,
                                messages: recentMessages,
                                totalTokens,
                            }, null, 2),
                        },
                    ],
                };
            }
            else if (format === 'formatted') {
                let text = `# Conversation Context: ${conversationId}\n\n`;
                if (trailingSummary) {
                    text += `## Previous Context Summary\n${trailingSummary}\n\n`;
                }
                if (executiveSummary) {
                    text += `## Executive Summary\n${executiveSummary}\n\n`;
                }
                text += `## Recent Messages (${recentMessages.length} messages, ~${totalTokens} tokens)\n\n`;
                for (const msg of recentMessages) {
                    text += `**${msg.role.toUpperCase()}** (${new Date(msg.timestamp).toISOString()}):\n${msg.content}\n\n`;
                }
                return { content: [{ type: 'text', text }] };
            }
            else {
                // LLM format: ready to use in model input
                const llmMessages = [];
                if (includeSystemPrompt && systemPromptText) {
                    llmMessages.push({ role: 'system', content: systemPromptText });
                }
                if (trailingSummary) {
                    llmMessages.push({
                        role: 'user',
                        content: `[Previous conversation context: ${trailingSummary}]`,
                    });
                }
                for (const msg of recentMessages) {
                    llmMessages.push({ role: msg.role, content: msg.content });
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                messages: llmMessages,
                                metadata: {
                                    conversationId,
                                    messageCount: recentMessages.length,
                                    totalTokens,
                                    hasTrailingSummary: !!trailingSummary,
                                    hasExecutiveSummary: !!executiveSummary,
                                },
                            }, null, 2),
                        },
                    ],
                };
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const duration = Date.now() - startTime;
            console.error(`[get_context] Error: ${msg}`);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to build context history: ${msg}`,
                    },
                ],
                isError: true,
            };
        }
    }),
};
exports.default = getContext;
module.exports = getContext;
