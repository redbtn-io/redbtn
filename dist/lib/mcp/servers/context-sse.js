"use strict";
/**
 * Context MCP Server - SSE Transport (Simplified)
 * Manages conversation context, history, and message storage
 * This is a simplified wrapper around the existing MemoryManager
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
exports.ContextServerSSE = void 0;
const server_sse_1 = require("../server-sse");
const memory_1 = require("../../memory/memory");
class ContextServerSSE extends server_sse_1.McpServerSSE {
    constructor(name, version, port = 3004, redisUrl) {
        super(name, version, port, '/mcp');
        this.memoryManager = new memory_1.MemoryManager(redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');
        console.log('[Context Server] Initialized with Redis memory manager');
    }
    /**
     * Setup tools (simplified - just the essential ones)
     */
    setup() {
        return __awaiter(this, void 0, void 0, function* () {
            // Store message tool
            this.defineTool({
                name: 'store_message',
                description: 'Store a message in conversation history',
                inputSchema: {
                    type: 'object',
                    properties: {
                        conversationId: { type: 'string' },
                        role: { type: 'string', enum: ['user', 'assistant', 'system'] },
                        content: { type: 'string' },
                        messageId: { type: 'string' },
                        timestamp: { type: 'number' }
                    },
                    required: ['conversationId', 'role', 'content']
                }
            });
            // Get context history tool
            this.defineTool({
                name: 'get_context_history',
                description: 'Get formatted conversation context for LLM',
                inputSchema: {
                    type: 'object',
                    properties: {
                        conversationId: { type: 'string' },
                        maxTokens: { type: 'number', default: 30000 }
                    },
                    required: ['conversationId']
                }
            });
            // Get summary tool
            this.defineTool({
                name: 'get_summary',
                description: 'Get conversation summary if available',
                inputSchema: {
                    type: 'object',
                    properties: {
                        conversationId: { type: 'string' }
                    },
                    required: ['conversationId']
                }
            });
            // Get messages tool
            this.defineTool({
                name: 'get_messages',
                description: 'Fetch messages from a conversation',
                inputSchema: {
                    type: 'object',
                    properties: {
                        conversationId: { type: 'string' },
                        limit: { type: 'number', default: 100 }
                    },
                    required: ['conversationId']
                }
            });
            // Get conversation metadata tool
            this.defineTool({
                name: 'get_conversation_metadata',
                description: 'Get metadata about a conversation',
                inputSchema: {
                    type: 'object',
                    properties: {
                        conversationId: { type: 'string' }
                    },
                    required: ['conversationId']
                }
            });
            this.capabilities = {
                tools: { listChanged: false }
            };
        });
    }
    /**
     * Execute tool
     */
    executeTool(name, args, meta) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                switch (name) {
                    case 'store_message':
                        yield this.memoryManager.addMessage(args.conversationId, {
                            id: args.messageId || `msg_${Date.now()}`,
                            role: args.role,
                            content: args.content,
                            timestamp: args.timestamp || Date.now(),
                            toolExecutions: args.toolExecutions || []
                        });
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ success: true }) }]
                        };
                    case 'get_context_history':
                        const context = yield this.memoryManager.getContextForConversation(args.conversationId);
                        return {
                            content: [{ type: 'text', text: JSON.stringify(context) }]
                        };
                    case 'get_summary':
                        const summary = yield this.memoryManager.getContextSummary(args.conversationId);
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ summary: summary || null }) }]
                        };
                    case 'get_messages':
                        const messages = yield this.memoryManager.getMessages(args.conversationId);
                        return {
                            content: [{ type: 'text', text: JSON.stringify(messages) }]
                        };
                    case 'get_conversation_metadata':
                        const metadata = yield this.memoryManager.getMetadata(args.conversationId);
                        return {
                            content: [{ type: 'text', text: JSON.stringify(metadata || {}) }]
                        };
                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            }
            catch (error) {
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
                        }],
                    isError: true
                };
            }
        });
    }
}
exports.ContextServerSSE = ContextServerSSE;
