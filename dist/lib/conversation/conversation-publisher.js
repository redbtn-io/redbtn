"use strict";
/**
 * ConversationPublisher -- publishes messages and events to a conversation stream.
 *
 * Unlike RunPublisher (which manages run lifecycle state), this is a pure event
 * emitter. Multiple publishers can target the same conversation simultaneously.
 *
 * Events are published to:
 * - Redis pub/sub channel: conversation:stream:{conversationId}
 * - Redis list: conversation:events:{conversationId} (for replay)
 *
 * Messages can optionally be persisted to MongoDB via the conversation model.
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
exports.ConversationPublisher = void 0;
exports.createConversationPublisher = createConversationPublisher;
const types_1 = require("./types");
class ConversationPublisher {
    constructor(options) {
        var _a;
        this.redis = options.redis;
        this.conversationId = options.conversationId;
        this.userId = options.userId;
        this.channel = types_1.ConversationKeys.stream(options.conversationId);
        this.eventsKey = types_1.ConversationKeys.events(options.conversationId);
        this.ttl = (_a = options.eventsTtl) !== null && _a !== void 0 ? _a : types_1.ConversationConfig.EVENTS_TTL_SECONDS;
    }
    /**
     * Push a complete message to the conversation.
     * Published immediately and optionally persisted to MongoDB.
     */
    pushMessage(params) {
        return __awaiter(this, void 0, void 0, function* () {
            const messageId = params.messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            yield this.publish({
                type: 'message',
                messageId,
                role: params.role,
                content: params.content,
                metadata: params.metadata,
                timestamp: Date.now(),
            });
            // Persist to MongoDB if requested (default: true)
            if (params.persist !== false) {
                yield this.persistMessage({
                    messageId,
                    role: params.role,
                    content: params.content,
                    metadata: params.metadata,
                });
            }
            return messageId;
        });
    }
    /** Begin streaming a message -- UI shows an empty bubble */
    startMessage(messageId_1) {
        return __awaiter(this, arguments, void 0, function* (messageId, role = 'assistant') {
            yield this.publish({
                type: 'message_start',
                messageId,
                role,
                timestamp: Date.now(),
            });
        });
    }
    /** Stream a chunk of content to an active message */
    streamChunk(messageId, content, thinking) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.publish({
                type: 'message_chunk',
                messageId,
                content,
                thinking: thinking || false,
                timestamp: Date.now(),
            });
        });
    }
    /** Complete a streaming message */
    completeMessage(messageId, finalContent) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.publish({
                type: 'message_complete',
                messageId,
                finalContent,
                timestamp: Date.now(),
            });
        });
    }
    // ── Run-aware streaming methods ──
    // Used by RunPublisher to forward events to the conversation stream.
    /** Signal a run has started in this conversation */
    publishRunStart(runId, messageId, graphId, graphName) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.publish({
                type: 'run_start',
                runId,
                messageId,
                graphId,
                graphName,
                timestamp: Date.now(),
            });
        });
    }
    /** Stream a thinking/reasoning chunk from a run */
    streamThinking(runId, messageId, content) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.publish({
                type: 'thinking_chunk',
                runId,
                messageId,
                content,
                timestamp: Date.now(),
            });
        });
    }
    /** Stream a content chunk from a run */
    streamContent(runId, messageId, content) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.publish({
                type: 'content_chunk',
                runId,
                messageId,
                content,
                timestamp: Date.now(),
            });
        });
    }
    /** Publish a tool event from a run */
    publishToolEvent(runId, event) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.publish({
                type: 'tool_event',
                runId,
                event,
                timestamp: Date.now(),
            });
        });
    }
    /** Signal a run has completed in this conversation */
    publishRunComplete(runId, messageId, finalContent) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.publish({
                type: 'run_complete',
                runId,
                messageId,
                finalContent,
                timestamp: Date.now(),
            });
        });
    }
    /** Signal a run has failed in this conversation */
    publishRunError(runId, messageId, error) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.publish({
                type: 'run_error',
                runId,
                messageId,
                error,
                timestamp: Date.now(),
            });
        });
    }
    /** Show/hide typing indicator */
    setTyping(isTyping, sourceRunId) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.publish({
                type: 'typing',
                isTyping,
                sourceRunId,
                timestamp: Date.now(),
            });
        });
    }
    /** Send a status update */
    status(action, description) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.publish({
                type: 'status',
                action,
                description,
                timestamp: Date.now(),
            });
        });
    }
    // -- Internal --
    publish(event) {
        return __awaiter(this, void 0, void 0, function* () {
            const json = JSON.stringify(event);
            // Publish to pub/sub for live listeners
            yield this.redis.publish(this.channel, json);
            // Store in list for replay on reconnection
            yield this.redis.rpush(this.eventsKey, json);
            yield this.redis.expire(this.eventsKey, this.ttl);
        });
    }
    persistMessage(params) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Use mongoose to persist to the conversation
                // Import dynamically to avoid circular deps and work in both webapp and worker
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const mongoose = require('mongoose');
                if (mongoose.connection.readyState !== 1)
                    return; // Skip if not connected
                const db = mongoose.connection.db;
                if (!db)
                    return;
                // Add message to the conversation's messages array
                const { ObjectId } = mongoose.Types;
                const filter = ObjectId.isValid(this.conversationId)
                    ? { _id: new ObjectId(this.conversationId) }
                    : { conversationId: this.conversationId };
                yield db.collection('user_conversations').updateOne(filter, {
                    $push: {
                        messages: {
                            messageId: params.messageId,
                            role: params.role,
                            content: params.content,
                            metadata: params.metadata,
                            timestamp: new Date(),
                        },
                    },
                    $set: {
                        lastMessageAt: new Date(),
                        updatedAt: new Date(),
                    },
                });
                // Emit stored event
                yield this.publish({
                    type: 'message_stored',
                    messageId: params.messageId,
                    timestamp: Date.now(),
                });
            }
            catch (err) {
                console.error('[ConversationPublisher] Failed to persist message:', err);
                // Non-fatal -- the message was still published to the stream
            }
        });
    }
}
exports.ConversationPublisher = ConversationPublisher;
function createConversationPublisher(options) {
    return new ConversationPublisher(options);
}
