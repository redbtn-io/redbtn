"use strict";
/**
 * Unified Tool Event Protocol
 *
 * Standardized event format for all tool executions (thinking, web search,
 * database queries, code execution, etc.). Tools publish these events to
 * Redis pub/sub for real-time client updates.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createToolId = void 0;
/**
 * Helper to create tool event IDs
 */
const createToolId = (toolType, messageId) => {
    return `${toolType}_${messageId}_${Date.now()}`;
};
exports.createToolId = createToolId;
