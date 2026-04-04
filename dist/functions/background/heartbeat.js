"use strict";
/**
 * Node heartbeat utilities for distributed system monitoring
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
exports.startHeartbeat = startHeartbeat;
exports.sendHeartbeat = sendHeartbeat;
exports.stopHeartbeat = stopHeartbeat;
exports.getActiveNodes = getActiveNodes;
/**
 * Starts the heartbeat mechanism to register this node as active in Redis.
 * Heartbeat runs every 10 seconds with a 20-second TTL.
 */
function startHeartbeat(nodeId, redis) {
    if (!nodeId) {
        console.warn('[Heartbeat] No nodeId set, skipping heartbeat');
        throw new Error('nodeId is required for heartbeat');
    }
    // Initial heartbeat
    sendHeartbeat(nodeId, redis);
    // Set up interval for continuous heartbeats
    const interval = setInterval(() => {
        sendHeartbeat(nodeId, redis);
    }, 10000); // Every 10 seconds
    console.log(`[Heartbeat] Started for node: ${nodeId}`);
    return interval;
}
/**
 * Sends a heartbeat signal to Redis, adding the node to the active set.
 */
function sendHeartbeat(nodeId, redis) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!nodeId)
            return;
        try {
            const key = `nodes:active:${nodeId}`;
            const timestamp = Date.now();
            // Set key with value as timestamp and 20-second TTL
            yield redis.setex(key, 20, timestamp.toString());
        }
        catch (error) {
            console.error('[Heartbeat] Failed to send heartbeat:', error);
        }
    });
}
/**
 * Stops the heartbeat mechanism and removes the node from active set.
 */
function stopHeartbeat(nodeId, redis, interval) {
    return __awaiter(this, void 0, void 0, function* () {
        if (interval) {
            clearInterval(interval);
        }
        if (nodeId) {
            try {
                // Remove node from active set
                const key = `nodes:active:${nodeId}`;
                yield redis.del(key);
                console.log(`[Heartbeat] Stopped for node: ${nodeId}`);
            }
            catch (error) {
                console.error('[Heartbeat] Failed to cleanup on stop:', error);
            }
        }
    });
}
/**
 * Gets a list of all currently active nodes.
 * @returns Array of active node IDs
 */
function getActiveNodes(redis) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Scan for all keys matching nodes:active:*
            const keys = yield redis.keys('nodes:active:*');
            // Extract nodeId from keys (nodes:active:nodeId)
            return keys.map((key) => key.replace('nodes:active:', ''));
        }
        catch (error) {
            console.error('[Heartbeat] Failed to get active nodes:', error);
            return [];
        }
    });
}
