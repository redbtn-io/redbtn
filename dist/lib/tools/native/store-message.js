"use strict";
/**
 * Store Message — Native Context Tool
 *
 * Stores a message in conversation history via MemoryManager.
 * Persists to both Redis cache and MongoDB. Produces identical results
 * to the MCP context-sse.ts `store_message` handler.
 *
 * Ported from: src/lib/mcp/servers/context-sse.ts → store_message
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
const storeMessage = {
    description: 'Store a message in conversation history. Persists to both Redis cache and MongoDB.',
    server: 'context',
    inputSchema: {
        type: 'object',
        properties: {
            conversationId: {
                type: 'string',
                description: 'The conversation ID',
            },
            role: {
                type: 'string',
                enum: ['system', 'user', 'assistant'],
                description: 'Message role',
            },
            content: {
                type: 'string',
                description: 'Message content',
            },
            messageId: {
                type: 'string',
                description: 'Optional message ID (auto-generated if not provided)',
            },
            metadata: {
                type: 'object',
                description: 'Additional metadata',
                additionalProperties: true,
            },
            toolExecutions: {
                type: 'array',
                description: 'Array of tool execution data',
                items: { type: 'object' },
            },
        },
        required: ['conversationId', 'role', 'content'],
    },
    handler: (rawArgs, context) => __awaiter(void 0, void 0, void 0, function* () {
        const args = rawArgs;
        const { conversationId, role, content, messageId, toolExecutions, } = args;
        const publisher = (context === null || context === void 0 ? void 0 : context.publisher) || null;
        const nodeId = (context === null || context === void 0 ? void 0 : context.nodeId) || 'store_message';
        const startTime = Date.now();
        console.log(`[store_message] conversationId:${conversationId}, role:${role}, ` +
            `messageId:${messageId || '(auto)'}, content length:${content === null || content === void 0 ? void 0 : content.length}`);
        try {
            const mm = getMemoryManager();
            // Generate message ID if not provided
            const finalMessageId = messageId || `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;
            // Create message object
            const message = {
                id: finalMessageId,
                role,
                content,
                timestamp: Date.now(),
                toolExecutions: toolExecutions,
            };
            // Store via memory manager (handles both Redis and MongoDB)
            yield mm.addMessage(conversationId, message);
            const duration = Date.now() - startTime;
            console.log(`[store_message] Stored in ${duration}ms — messageId:${finalMessageId}`);
            // Publish progress via RunPublisher if available
            if (publisher) {
                try {
                    publisher.publish({
                        type: 'tool_output',
                        nodeId,
                        data: {
                            chunk: `[store_message] Stored ${role} message in ${conversationId} (${duration}ms)\n`,
                            stream: 'stdout',
                        },
                    });
                }
                catch (_) { /* ignore */ }
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            conversationId,
                            messageId: finalMessageId,
                            timestamp: message.timestamp,
                        }),
                    },
                ],
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const duration = Date.now() - startTime;
            console.error(`[store_message] Error: ${msg}`);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: false, error: msg, durationMs: duration }),
                    },
                ],
                isError: true,
            };
        }
    }),
};
exports.default = storeMessage;
module.exports = storeMessage;
