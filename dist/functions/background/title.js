"use strict";
/**
 * Background title generation utilities
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
exports.generateTitleInBackground = generateTitleInBackground;
exports.setConversationTitle = setConversationTitle;
exports.getConversationTitle = getConversationTitle;
const thinking_1 = require("../../lib/utils/thinking");
const database_1 = require("../../lib/memory/database");
const retry_1 = require("../../lib/utils/retry");
/**
 * Generate a title for the conversation based on the first few messages
 * Runs after 2nd message (initial title) and 6th message (refined title)
 */
function generateTitleInBackground(conversationId, messageCount, red, chatModel) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        try {
            // Only generate title after 2nd or 6th message
            if (messageCount !== 2 && messageCount !== 6) {
                return;
            }
            // Check if title was manually set by user via Context MCP
            const metadataResult = yield red.callMcpTool('get_conversation_metadata', {
                conversationId
            }, { conversationId });
            if (metadataResult.isError) {
                console.error('[Title] Failed to get metadata:', metadataResult.content);
                return;
            }
            const metadata = JSON.parse(((_b = (_a = metadataResult.content) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.text) || '{}');
            if (metadata === null || metadata === void 0 ? void 0 : metadata.titleSetByUser) {
                return; // Don't override user-set titles after 6th message
            }
            // Get recent messages for context via Context MCP
            const messagesResult = yield red.callMcpTool('get_messages', {
                conversationId,
                limit: 6,
                source: 'auto'
            }, { conversationId });
            if (messagesResult.isError) {
                console.error('[Title] Failed to get messages:', messagesResult.content);
                return;
            }
            const messages = JSON.parse(((_d = (_c = messagesResult.content) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.text) || '[]');
            const conversationText = messages
                .slice(0, Math.min(6, messages.length)) // Use first 6 messages max
                .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
                .join('\n');
            // Create prompt for title generation
            const titlePrompt = `Based on this conversation, generate a short, descriptive title (5 words max). Only respond with the title, nothing else:

${conversationText}`;
            // Generate title using LLM
            const response = yield (0, retry_1.invokeWithRetry)(chatModel, [{ role: 'user', content: titlePrompt }], {
                context: 'title generation',
            });
            const rawContent = response.content;
            // Extract thinking (if present) and get cleaned content
            const { cleanedContent } = (0, thinking_1.extractThinking)(rawContent);
            let title = cleanedContent.trim().replace(/^["']|["']$/g, ''); // Remove quotes if any
            // Enforce 5 word limit
            const words = title.split(/\s+/);
            if (words.length > 5) {
                title = words.slice(0, 5).join(' ');
            }
            // Store title in Redis metadata (use memory manager for direct access)
            const metaKey = `conversation:${conversationId}:metadata`;
            yield red.memory['redis'].hset(metaKey, 'title', title);
            // Also update title in MongoDB database
            const database = yield (0, database_1.getDatabase)();
            yield database.updateConversationTitle(conversationId, title);
            console.log(`[Red] Generated title for ${conversationId}: "${title}"`);
        }
        catch (err) {
            console.error('[Red] Title generation failed:', err);
        }
    });
}
/**
 * Set a custom title for a conversation (set by user)
 * This prevents automatic title generation from overwriting it
 */
function setConversationTitle(conversationId, title, red) {
    return __awaiter(this, void 0, void 0, function* () {
        const metaKey = `conversation:${conversationId}:metadata`;
        yield red.memory['redis'].hset(metaKey, {
            'title': title,
            'titleSetByUser': 'true'
        });
        // Also update title in MongoDB database
        const database = yield (0, database_1.getDatabase)();
        yield database.updateConversationTitle(conversationId, title);
        console.log(`[Red] User set title for ${conversationId}: "${title}"`);
    });
}
/**
 * Get the title for a conversation
 */
function getConversationTitle(conversationId, red) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const metadataResult = yield red.callMcpTool('get_conversation_metadata', {
            conversationId
        }, { conversationId });
        if (metadataResult.isError) {
            return null;
        }
        const metadata = JSON.parse(((_b = (_a = metadataResult.content) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.text) || '{}');
        return (metadata === null || metadata === void 0 ? void 0 : metadata.title) || null;
    });
}
