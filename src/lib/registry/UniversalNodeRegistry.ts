/**
 * UniversalNodeRegistry
 *
 * Runtime registry for universal node configs loaded from MongoDB.
 * Provides LRU-cached access to node configs by nodeId.
 *
 * Cache invalidation:
 * - Redis pub/sub on channel `node:invalidate` (message = nodeId)
 * - MongoDB change stream on the `nodes` collection
 */

import { LRUCache } from 'lru-cache';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const nodeCache = new LRUCache<string, any>({
  max: 200,
  ttl: 5 * 60 * 1000, // 5-min TTL
});

// ---------------------------------------------------------------------------
// Lazy mongoose model (uses the engine's bundled mongoose connection)
// ---------------------------------------------------------------------------

function getNodeModel(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mongoose = require('mongoose');
  if (mongoose.models && mongoose.models['_UNRNode']) {
    return mongoose.models['_UNRNode'];
  }
  const schema = new mongoose.Schema({}, { collection: 'nodes', strict: false });
  return mongoose.model('_UNRNode', schema);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a formatted node config from MongoDB (or cache).
 * Returns the raw document as a NodeConfig-compatible object.
 */
export async function getUniversalNode(nodeId: string): Promise<any | null> {
  const cached = nodeCache.get(nodeId);
  if (cached !== undefined) return cached;

  try {
    const Node = getNodeModel();
    const doc = await Node.findOne({ nodeId }).lean();
    if (!doc) {
      console.warn(`[UniversalNodeRegistry] Node not found: ${nodeId}`);
      return null;
    }
    // Convert Mongoose lean doc (has _id etc.) to plain object
    const result = JSON.parse(JSON.stringify(doc));
    nodeCache.set(nodeId, result);
    return result;
  } catch (err) {
    console.error(`[UniversalNodeRegistry] Failed to load node "${nodeId}":`, err);
    return null;
  }
}

/**
 * Load the raw node document (same as getUniversalNode — returns full doc).
 * Callers use this to access the `parameters` field in its original schema format.
 */
export async function getUniversalNodeRaw(nodeId: string): Promise<any | null> {
  return getUniversalNode(nodeId);
}

// ---------------------------------------------------------------------------
// Cache invalidation hooks (wired up by the worker at startup)
// ---------------------------------------------------------------------------

export const universalNodeRegistry = {
  /**
   * Subscribe to Redis pub/sub for targeted cache invalidation.
   * The channel `node:invalidate` carries the nodeId as the message payload.
   */
  async subscribeToInvalidations(redisUrl: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const IORedis = require('ioredis');
    const sub = new IORedis.default(redisUrl, { lazyConnect: true });
    await sub.connect();
    await sub.subscribe('node:invalidate');
    sub.on('message', (_channel: string, message: string) => {
      if (message) {
        nodeCache.delete(message);
      } else {
        nodeCache.clear();
      }
    });
  },

  /**
   * Watch the `nodes` MongoDB collection for changes and clear affected cache entries.
   */
  async watchCollection(db: any): Promise<void> {
    const changeStream = db.collection('nodes').watch([], { fullDocument: 'updateLookup' });
    changeStream.on('change', (change: any) => {
      const nodeId = change.fullDocument?.nodeId || change.documentKey?._id;
      if (typeof nodeId === 'string') {
        nodeCache.delete(nodeId);
      } else {
        nodeCache.clear();
      }
    });
  },
};
