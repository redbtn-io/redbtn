"use strict";
/**
 * push_message -- native tool for sending messages to conversations
 *
 * Pushes a message to a conversation stream in real-time.
 * The message appears immediately in the chat UI and is persisted to MongoDB.
 *
 * Can target the current run's conversation (default) or any conversation by ID.
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
const definition = {
    description: 'Push a message to a conversation. Appears instantly in the chat UI and is saved to the database. Can target any conversation by ID.',
    server: 'system',
    inputSchema: {
        type: 'object',
        properties: {
            content: {
                type: 'string',
                description: 'Message content to send',
            },
            conversationId: {
                type: 'string',
                description: 'Target conversation ID. Defaults to the current run\'s conversation.',
            },
            role: {
                type: 'string',
                enum: ['assistant', 'system'],
                description: 'Message role (default: assistant)',
            },
        },
        required: ['content'],
    },
    handler(args, context) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            const content = (args.content || '').trim();
            if (!content) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'Content is required' }) }],
                    isError: true,
                };
            }
            const role = args.role || 'assistant';
            // Determine target conversation
            const conversationId = args.conversationId
                || ((_b = (_a = context.state) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.conversationId)
                || ((_d = (_c = context.state) === null || _c === void 0 ? void 0 : _c.options) === null || _d === void 0 ? void 0 : _d.conversationId)
                || ((_e = context.state) === null || _e === void 0 ? void 0 : _e.conversationId);
            if (!conversationId) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'No conversationId available. Pass it explicitly or run within a conversation context.' }) }],
                    isError: true,
                };
            }
            const { publisher } = context;
            (_f = publisher === null || publisher === void 0 ? void 0 : publisher.emit) === null || _f === void 0 ? void 0 : _f.call(publisher, 'log', `push_message to ${conversationId}: ${content.substring(0, 50)}...`);
            try {
                // Get Redis connection from environment
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const IORedis = require('ioredis');
                const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
                const redis = new IORedis(redisUrl);
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { createConversationPublisher } = require('../../conversation/index');
                    const convPublisher = createConversationPublisher({
                        redis,
                        conversationId,
                    });
                    const messageId = yield convPublisher.pushMessage({
                        role: role,
                        content,
                        metadata: {
                            source: 'push_message_tool',
                            runId: (_g = context.state) === null || _g === void 0 ? void 0 : _g.runId,
                        },
                    });
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    success: true,
                                    messageId,
                                    conversationId,
                                }),
                            }],
                    };
                }
                finally {
                    yield redis.quit().catch(() => { });
                }
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : 'Unknown error';
                (_h = publisher === null || publisher === void 0 ? void 0 : publisher.emit) === null || _h === void 0 ? void 0 : _h.call(publisher, 'log', `push_message failed: ${msg}`);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: `Failed to push message: ${msg}` }) }],
                    isError: true,
                };
            }
        });
    },
};
module.exports = definition;
