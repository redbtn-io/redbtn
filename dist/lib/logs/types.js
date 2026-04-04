"use strict";
/**
 * Log types and data structures for the Red AI logging system
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TTL = exports.RedisKeys = void 0;
/**
 * Redis key patterns
 */
exports.RedisKeys = {
    // Log storage
    log: (logId) => `log:${logId}`,
    generationLogs: (genId) => `generation:${genId}:logs`,
    conversationLogs: (convId) => `conversation:${convId}:logs`,
    // Generation tracking
    generation: (genId) => `generation:${genId}`,
    conversationGeneration: (convId) => `conversation:${convId}:generation`,
    // Pub/sub channels
    logChannel: (genId) => `logs:generation:${genId}`,
    conversationLogChannel: (convId) => `logs:conversation:${convId}`,
    allLogsChannel: 'logs:all',
};
/**
 * TTL values (in seconds)
 */
exports.TTL = {
    LOG: 30 * 24 * 60 * 60, // 30 days for individual logs
    GENERATION: 30 * 24 * 60 * 60, // 30 days for generation data
    LOG_LIST: 30 * 24 * 60 * 60, // 30 days for log lists
};
