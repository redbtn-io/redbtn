"use strict";
/**
 * Conversation-level streaming types and Redis key patterns.
 *
 * Unlike run streams (scoped to a single execution), conversation streams
 * are persistent channels that any producer can publish to -- runs, automations,
 * the push_message tool, or external triggers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationConfig = exports.ConversationKeys = void 0;
exports.ConversationKeys = {
    /** Pub/sub channel for real-time events */
    stream: (conversationId) => `conversation:stream:${conversationId}`,
    /** Event list for replay on reconnection (short TTL) */
    events: (conversationId) => `conversation:events:${conversationId}`,
};
exports.ConversationConfig = {
    /** Events list TTL -- just enough for reconnection, not long-term history */
    EVENTS_TTL_SECONDS: 5 * 60, // 5 minutes
};
