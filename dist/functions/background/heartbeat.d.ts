/**
 * Node heartbeat utilities for distributed system monitoring
 */
import type Redis from 'ioredis';
/**
 * Starts the heartbeat mechanism to register this node as active in Redis.
 * Heartbeat runs every 10 seconds with a 20-second TTL.
 */
export declare function startHeartbeat(nodeId: string, redis: Redis): NodeJS.Timeout;
/**
 * Sends a heartbeat signal to Redis, adding the node to the active set.
 */
export declare function sendHeartbeat(nodeId: string, redis: Redis): Promise<void>;
/**
 * Stops the heartbeat mechanism and removes the node from active set.
 */
export declare function stopHeartbeat(nodeId: string | undefined, redis: Redis, interval: NodeJS.Timeout | undefined): Promise<void>;
/**
 * Gets a list of all currently active nodes.
 * @returns Array of active node IDs
 */
export declare function getActiveNodes(redis: Redis): Promise<string[]>;
