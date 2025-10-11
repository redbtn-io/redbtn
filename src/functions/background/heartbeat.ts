/**
 * Node heartbeat utilities for distributed system monitoring
 */

import type Redis from 'ioredis';

/**
 * Starts the heartbeat mechanism to register this node as active in Redis.
 * Heartbeat runs every 10 seconds with a 20-second TTL.
 */
export function startHeartbeat(
  nodeId: string,
  redis: Redis
): NodeJS.Timeout {
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
export async function sendHeartbeat(
  nodeId: string,
  redis: Redis
): Promise<void> {
  if (!nodeId) return;

  try {
    const key = `nodes:active:${nodeId}`;
    const timestamp = Date.now();
    
    // Set key with value as timestamp and 20-second TTL
    await redis.setex(key, 20, timestamp.toString());
  } catch (error) {
    console.error('[Heartbeat] Failed to send heartbeat:', error);
  }
}

/**
 * Stops the heartbeat mechanism and removes the node from active set.
 */
export async function stopHeartbeat(
  nodeId: string | undefined,
  redis: Redis,
  interval: NodeJS.Timeout | undefined
): Promise<void> {
  if (interval) {
    clearInterval(interval);
  }

  if (nodeId) {
    try {
      // Remove node from active set
      const key = `nodes:active:${nodeId}`;
      await redis.del(key);
      console.log(`[Heartbeat] Stopped for node: ${nodeId}`);
    } catch (error) {
      console.error('[Heartbeat] Failed to cleanup on stop:', error);
    }
  }
}

/**
 * Gets a list of all currently active nodes.
 * @returns Array of active node IDs
 */
export async function getActiveNodes(redis: Redis): Promise<string[]> {
  try {
    // Scan for all keys matching nodes:active:*
    const keys = await redis.keys('nodes:active:*');
    // Extract nodeId from keys (nodes:active:nodeId)
    return keys.map((key: string) => key.replace('nodes:active:', ''));
  } catch (error) {
    console.error('[Heartbeat] Failed to get active nodes:', error);
    return [];
  }
}
