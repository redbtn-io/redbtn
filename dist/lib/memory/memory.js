"use strict";
/**
 * @file src/lib/memory.ts
 * @description Conversation memory management with MongoDB persistence and Redis caching
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryManager = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const tokenizer_1 = require("../utils/tokenizer");
const database_1 = require("./database");
class MemoryManager {
    constructor(redisUrl) {
        this.MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || '30000');
        this.SUMMARY_CUSHION_TOKENS = parseInt(process.env.SUMMARY_CUSHION_TOKENS || '2000');
        this.REDIS_MESSAGE_LIMIT = 100; // Keep last 100 messages in Redis for hot context
        this.MESSAGE_ID_INDEX_TTL = parseInt(process.env.CONVERSATION_MESSAGE_ID_TTL || (60 * 60 * 24 * 30).toString());
        this.redisUrl = redisUrl;
        this.redis = new ioredis_1.default(redisUrl);
    }
    /**
     * Generate a conversation ID based on initial message content (stable hashing)
     * or create a random ID if no seed is provided
     */
    generateConversationId(seedMessage) {
        if (seedMessage) {
            // Create stable ID based on message content
            const crypto = require('crypto');
            const hash = crypto.createHash('sha256').update(seedMessage).digest('hex').substring(0, 16);
            return `conv_${hash}`;
        }
        // Generate random ID for one-off conversations
        const crypto = require('crypto');
        return `conv_${crypto.randomBytes(8).toString('hex')}`;
    }
    /**
     * Count tokens in a message
     */
    countMessageTokens(message) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Format: role + content + overhead (4 tokens per message for formatting)
                const roleTokens = yield (0, tokenizer_1.countTokens)(message.role);
                const contentTokens = yield (0, tokenizer_1.countTokens)(message.content);
                return roleTokens + contentTokens + 4;
            }
            catch (error) {
                // Fallback: rough estimate (1 token ≈ 4 characters)
                return Math.ceil((message.role.length + message.content.length) / 4);
            }
        });
    }
    /**
     * Count tokens in multiple messages
     */
    countMessagesTokens(messages) {
        return __awaiter(this, void 0, void 0, function* () {
            let total = 0;
            for (const msg of messages) {
                total += yield this.countMessageTokens(msg);
            }
            return total;
        });
    }
    /**
     * Get conversation context: returns messages that fit within token limit.
     * Use getContextSummary() separately to retrieve summary for merging with system prompts.
     */
    getContextForConversation(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const messages = yield this.getMessages(conversationId);
            // Calculate tokens and return messages that fit within limit
            let totalTokens = 0;
            const recentMessages = [];
            // Work backwards from most recent message
            for (let i = messages.length - 1; i >= 0; i--) {
                const msgTokens = yield this.countMessageTokens(messages[i]);
                if (totalTokens + msgTokens <= this.MAX_CONTEXT_TOKENS) {
                    recentMessages.unshift(messages[i]);
                    totalTokens += msgTokens;
                }
                else {
                    break;
                }
            }
            return recentMessages;
        });
    }
    /**
     * Get conversation summary (if exists) for manual inclusion in system prompts.
     * Returns null if no summary has been generated yet.
     * This returns the TRAILING summary (old trimmed messages).
     */
    getContextSummary(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.getTrailingSummary(conversationId);
        });
    }
    /**
     * Add a new message to the conversation
     * Stores in both MongoDB (persistence) and Redis (hot cache of last 100 messages)
     */
    addMessage(conversationId, message) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = `conversations:${conversationId}:messages`;
            const idIndexKey = `${key}:ids`;
            // Ensure message has an ID before we attempt to index it
            if (!message.id) {
                message.id = `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;
            }
            // Atomic duplicate guard – only the first writer wins
            let addedToIndex = 1;
            try {
                addedToIndex = yield this.redis.sadd(idIndexKey, message.id);
                yield this.redis.expire(idIndexKey, this.MESSAGE_ID_INDEX_TTL);
            }
            catch (error) {
                console.warn('[Memory] Failed to update message id index:', error instanceof Error ? error.message : String(error));
            }
            if (addedToIndex === 0) {
                console.log(`[Memory] Message ${message.id} already indexed for ${conversationId}, skipping duplicate`);
                return;
            }
            // Secondary guard in case the ID index was flushed but the list already contains the message
            const existingMessages = yield this.redis.lrange(key, 0, -1);
            const alreadyInList = existingMessages.some((msgJson) => {
                try {
                    const existingMsg = JSON.parse(msgJson);
                    return existingMsg.id === message.id;
                }
                catch (_a) {
                    return false;
                }
            });
            if (alreadyInList) {
                console.log(`[Memory] Message ${message.id} already exists in Redis cache for ${conversationId}, skipping duplicate`);
                return;
            }
            try {
                // Store in MongoDB for persistence (blocking to ensure consistency)
                yield (0, database_1.getDatabase)().storeMessage({
                    messageId: message.id,
                    conversationId,
                    role: message.role,
                    content: message.content,
                    timestamp: new Date(message.timestamp),
                    toolExecutions: message.toolExecutions || [],
                    metadata: {}
                }).catch(err => {
                    console.error('[Memory] Failed to save message to MongoDB:', err.message);
                    throw err; // Re-throw to trigger rollback
                });
                // Add to Redis (hot cache)
                yield this.redis.rpush(key, JSON.stringify(message));
                // Trim Redis to keep only last 100 messages
                const messageCount = yield this.redis.llen(key);
                if (messageCount > this.REDIS_MESSAGE_LIMIT) {
                    const trimCount = messageCount - this.REDIS_MESSAGE_LIMIT;
                    yield this.redis.ltrim(key, trimCount, -1);
                    console.log(`[Memory] Trimmed ${trimCount} old messages from Redis cache for ${conversationId}`);
                }
                // Update metadata
                yield this.updateMetadata(conversationId);
            }
            catch (error) {
                // Roll back index entry so a retry can succeed
                yield this.redis.srem(idIndexKey, message.id);
                throw error;
            }
        });
    }
    /**
     * Get all messages for a conversation from MongoDB (full history)
     * For recent hot context, messages are served from Redis cache
     */
    getMessages(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            // Try Redis first (hot cache - last 100 messages)
            const key = `conversations:${conversationId}:messages`;
            const messagesJson = yield this.redis.lrange(key, 0, -1);
            if (messagesJson.length > 0) {
                return messagesJson.map((json) => JSON.parse(json));
            }
            // If not in Redis, try to fetch from MongoDB and populate Redis
            try {
                const db = (0, database_1.getDatabase)();
                const dbMessages = yield db.getLastMessages(conversationId, this.REDIS_MESSAGE_LIMIT);
                if (dbMessages.length > 0) {
                    // Populate Redis cache
                    const pipeline = this.redis.pipeline();
                    for (const msg of dbMessages) {
                        const convMsg = {
                            id: msg.messageId, // Include message ID
                            role: msg.role,
                            content: msg.content,
                            timestamp: msg.timestamp.getTime(),
                            toolExecutions: msg.toolExecutions || [] // Include tool executions
                        };
                        pipeline.rpush(key, JSON.stringify(convMsg));
                        if (convMsg.id) {
                            pipeline.sadd(`${key}:ids`, convMsg.id);
                        }
                    }
                    pipeline.expire(`${key}:ids`, this.MESSAGE_ID_INDEX_TTL);
                    yield pipeline.exec();
                    console.log(`[Memory] Populated Redis cache with ${dbMessages.length} messages from MongoDB for ${conversationId}`);
                    return dbMessages.map(msg => ({
                        id: msg.messageId, // Include message ID
                        role: msg.role,
                        content: msg.content,
                        timestamp: msg.timestamp.getTime(),
                        toolExecutions: msg.toolExecutions || [] // Include tool executions
                    }));
                }
            }
            catch (error) {
                console.warn('[Memory] Failed to fetch from MongoDB:', error instanceof Error ? error.message : String(error));
            }
            return [];
        });
    }
    /**
     * Get all messages from MongoDB (for full conversation history)
     */
    getAllMessagesFromDB(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const db = (0, database_1.getDatabase)();
            const dbMessages = yield db.getMessages(conversationId);
            return dbMessages.map(msg => ({
                id: msg.messageId, // Include message ID
                role: msg.role,
                content: msg.content,
                timestamp: msg.timestamp.getTime(),
                toolExecutions: msg.toolExecutions || [] // Include tool executions
            }));
        });
    }
    /**
     * Get trailing summary (old trimmed messages)
     */
    getTrailingSummary(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = `conversations:${conversationId}:summary:trailing`;
            return yield this.redis.get(key);
        });
    }
    /**
     * Store trailing summary (old trimmed messages)
     */
    setTrailingSummary(conversationId, summary) {
        return __awaiter(this, void 0, void 0, function* () {
            const summaryKey = `conversations:${conversationId}:summary:trailing`;
            const metaKey = `conversations:${conversationId}:metadata`;
            yield this.redis.set(summaryKey, summary);
            yield this.redis.hset(metaKey, 'trailingSummaryGenerated', 'true');
            yield this.redis.hdel(metaKey, 'needsTrailingSummaryGeneration');
            yield this.redis.hdel(metaKey, 'contentToSummarize');
        });
    }
    /**
     * Get executive summary (full conversation overview)
     */
    getExecutiveSummary(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = `conversations:${conversationId}:summary:executive`;
            return yield this.redis.get(key);
        });
    }
    /**
     * Store executive summary (full conversation overview)
     */
    setExecutiveSummary(conversationId, summary) {
        return __awaiter(this, void 0, void 0, function* () {
            const summaryKey = `conversations:${conversationId}:summary:executive`;
            yield this.redis.set(summaryKey, summary);
            console.log(`[Memory] Updated executive summary for ${conversationId}`);
        });
    }
    /**
     * Get conversation metadata
     */
    getMetadata(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = `conversations:${conversationId}:metadata`;
            const data = yield this.redis.hgetall(key);
            if (Object.keys(data).length === 0) {
                return null;
            }
            return {
                conversationId,
                messageCount: parseInt(data.messageCount || '0'),
                lastUpdated: parseInt(data.lastUpdated || '0'),
                summaryGenerated: data.summaryGenerated === 'true',
                totalTokens: data.totalTokens ? parseInt(data.totalTokens) : undefined,
                title: data.title || undefined,
                titleSetByUser: data.titleSetByUser === 'true' || undefined
            };
        });
    }
    /**
     * Update conversation metadata
     */
    updateMetadata(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = `conversations:${conversationId}:metadata`;
            const messageCount = yield this.redis.llen(`conversations:${conversationId}:messages`);
            // Calculate total tokens
            const messages = yield this.getMessages(conversationId);
            const totalTokens = yield this.countMessagesTokens(messages);
            yield this.redis.hset(key, {
                messageCount: messageCount.toString(),
                lastUpdated: Date.now().toString(),
                totalTokens: totalTokens.toString()
            });
        });
    }
    /**
     * Check if conversation needs summarization and trimming.
     * Returns true when total tokens exceed MAX_CONTEXT_TOKENS + SUMMARY_CUSHION_TOKENS.
     */
    needsSummarization(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const messages = yield this.getMessages(conversationId);
            const totalTokens = yield this.countMessagesTokens(messages);
            // Trigger summarization when we exceed the context limit + cushion
            return totalTokens > (this.MAX_CONTEXT_TOKENS + this.SUMMARY_CUSHION_TOKENS);
        });
    }
    /**
     * Trim messages and generate summary to bring conversation under token limit.
     * This includes any existing summary in the summarization.
     */
    trimAndSummarize(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const messages = yield this.getMessages(conversationId);
            const existingSummary = yield this.getTrailingSummary(conversationId);
            // Calculate how many tokens we need to keep for recent context
            let recentTokens = 0;
            let keepFromIndex = messages.length;
            // Work backwards to find where to cut
            for (let i = messages.length - 1; i >= 0; i--) {
                const msgTokens = yield this.countMessageTokens(messages[i]);
                if (recentTokens + msgTokens <= this.MAX_CONTEXT_TOKENS) {
                    recentTokens += msgTokens;
                    keepFromIndex = i;
                }
                else {
                    break;
                }
            }
            // If all messages fit, no need to summarize
            if (keepFromIndex === 0) {
                return;
            }
            // Messages to summarize (everything before keepFromIndex)
            const messagesToSummarize = messages.slice(0, keepFromIndex);
            if (messagesToSummarize.length === 0) {
                return;
            }
            // Keep only recent messages in Redis
            const messagesToKeep = messages.slice(keepFromIndex);
            // Clear old messages and store only recent ones
            const messagesKey = `conversations:${conversationId}:messages`;
            yield this.redis.del(messagesKey);
            yield this.redis.del(`${messagesKey}:ids`);
            if (messagesToKeep.length > 0) {
                const pipeline = this.redis.pipeline();
                for (const msg of messagesToKeep) {
                    pipeline.rpush(messagesKey, JSON.stringify(msg));
                    if (msg.id) {
                        pipeline.sadd(`${messagesKey}:ids`, msg.id);
                    }
                }
                pipeline.expire(`${messagesKey}:ids`, this.MESSAGE_ID_INDEX_TTL);
                yield pipeline.exec();
            }
            // Build summary content (include existing summary if present)
            let contentToSummarize = '';
            if (existingSummary) {
                contentToSummarize += `Previous summary: ${existingSummary}\n\n`;
            }
            contentToSummarize += messagesToSummarize
                .map(m => `${m.role.toUpperCase()}: ${m.content}`)
                .join('\n');
            // Return the content to summarize (caller will invoke LLM)
            // Store a marker that we need to generate trailing summary
            const metaKey = `conversations:${conversationId}:metadata`;
            yield this.redis.hset(metaKey, 'needsTrailingSummaryGeneration', 'true');
            yield this.redis.hset(metaKey, 'contentToSummarize', contentToSummarize);
            // Update metadata
            yield this.updateMetadata(conversationId);
        });
    }
    /**
     * Get content that needs to be summarized (after trimAndSummarize was called)
     */
    getContentToSummarize(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const metaKey = `conversations:${conversationId}:metadata`;
            return yield this.redis.hget(metaKey, 'contentToSummarize');
        });
    }
    /**
     * Check if trailing summary generation is pending
     */
    needsSummaryGeneration(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const metaKey = `conversations:${conversationId}:metadata`;
            const value = yield this.redis.hget(metaKey, 'needsTrailingSummaryGeneration');
            return value === 'true';
        });
    }
    /**
     * Perform summarization if needed - complete workflow in one call.
     * @param conversationId The conversation to check and summarize
     * @param llmInvoker A function that takes a prompt and returns the LLM's response
     * @returns true if summarization was performed, false if not needed
     */
    summarizeIfNeeded(conversationId, llmInvoker) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const needsSummary = yield this.needsSummarization(conversationId);
                if (!needsSummary) {
                    return false;
                }
                const tokenCount = yield this.getTokenCount(conversationId);
                console.log(`[Memory] Token limit exceeded for ${conversationId}: ${tokenCount} tokens - trimming and summarizing...`);
                // Trim messages to fit within token limit
                yield this.trimAndSummarize(conversationId);
                // Check if summary generation is needed
                const needsGeneration = yield this.needsSummaryGeneration(conversationId);
                if (!needsGeneration) {
                    console.log(`[Memory] No summary generation needed for ${conversationId}`);
                    return false;
                }
                // Get content to summarize (includes previous summary if exists)
                const contentToSummarize = yield this.getContentToSummarize(conversationId);
                if (!contentToSummarize) {
                    return false;
                }
                // Create summary prompt
                const summaryPrompt = this.buildSummaryPrompt(contentToSummarize);
                // Generate summary using the provided LLM invoker
                const summary = yield llmInvoker(summaryPrompt);
                // Store the trailing summary
                yield this.setTrailingSummary(conversationId, summary);
                const newTokenCount = yield this.getTokenCount(conversationId);
                console.log(`[Memory] Summarization complete for ${conversationId}: trimmed to ${newTokenCount} tokens`);
                return true;
            }
            catch (error) {
                console.error('[Memory] Summarization error:', error);
                return false;
            }
        });
    }
    /**
     * Generate executive summary (full conversation overview).
     * Should be called after 3rd+ AI responses.
     * @param llmInvoker A function that takes a prompt and returns the LLM's response
     */
    generateExecutiveSummary(conversationId, llmInvoker) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const messages = yield this.getMessages(conversationId);
                if (messages.length === 0) {
                    return;
                }
                // Build full conversation text
                const conversationText = messages
                    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
                    .join('\n');
                const prompt = `Provide a comprehensive executive summary of the following conversation. Focus on:
- User's goals and preferences
- Key topics discussed
- Important decisions or conclusions
- Context that would be useful for future interactions

Keep it concise but informative (200-400 words). Only respond with the summary itself:

${conversationText}`;
                const summary = yield llmInvoker(prompt);
                yield this.setExecutiveSummary(conversationId, summary);
                console.log(`[Memory] Generated executive summary for ${conversationId}`);
            }
            catch (error) {
                console.error('[Memory] Executive summary generation error:', error);
            }
        });
    }
    /**
     * Build the prompt for summarization (can be overridden or customized)
     */
    buildSummaryPrompt(contentToSummarize) {
        return `Summarize the following conversation history concisely. Focus on information about the user, key topics, decisions, and important context. Retain key information from previous summaries if they exist. Only respond with the summary itself. Keep it over 500 but under 1000 words:

${contentToSummarize}`;
    }
    /**
     * Get current token count for a conversation (useful for monitoring)
     */
    getTokenCount(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const messages = yield this.getMessages(conversationId);
            return yield this.countMessagesTokens(messages);
        });
    }
    /**
     * Get token count for messages that would be returned by getContextForConversation
     */
    getContextTokenCount(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            const contextMessages = yield this.getContextForConversation(conversationId);
            return yield this.countMessagesTokens(contextMessages);
        });
    }
    /**
     * Delete a conversation (for cleanup/testing)
     */
    deleteConversation(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.redis.del(`conversations:${conversationId}:messages`);
            yield this.redis.del(`conversations:${conversationId}:messages:ids`);
            yield this.redis.del(`conversations:${conversationId}:summary:trailing`);
            yield this.redis.del(`conversations:${conversationId}:summary:executive`);
            yield this.redis.del(`conversations:${conversationId}:metadata`);
        });
    }
    /**
     * Close Redis connection and free tokenizer
     */
    close() {
        return __awaiter(this, void 0, void 0, function* () {
            (0, tokenizer_1.freeTiktoken)();
            yield this.redis.quit();
        });
    }
}
exports.MemoryManager = MemoryManager;
