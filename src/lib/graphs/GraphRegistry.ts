/**
 * GraphRegistry
 *
 * Phase 1: Dynamic Graph System
 * Manages dynamic loading, caching, and compilation of graph configurations.
 * Mirrors NeuronRegistry architecture pattern.
 *
 * Key Features:
 * - LRU cache for compiled graphs (5min TTL)
 * - Per-user graph compilation
 * - Tier-based access control
 * - System default graphs + user custom graphs
 * - JIT compilation from MongoDB configs
 */
import { LRUCache } from 'lru-cache';
import type { Db } from 'mongodb';
import { getDatabase } from '../memory/database';
import { Graph } from '../models/Graph';
import { compileGraphFromConfig, GraphCompilationError } from './compiler';
import { GraphConfig, CompiledGraph } from '../types/graph';
import type { RedConfig } from '../../index';

type PartialRedConfig = Pick<RedConfig, 'databaseUrl'> & Partial<Omit<RedConfig, 'databaseUrl'>>;

export class GraphNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'GraphNotFoundError'; }
}

export class GraphAccessDeniedError extends Error {
  constructor(message: string) { super(message); this.name = 'GraphAccessDeniedError'; }
}

export class GraphRegistry {
  private compiledCache: LRUCache<string, CompiledGraph>;
  private configCache: LRUCache<string, GraphConfig>;
  private db: ReturnType<typeof getDatabase>;
  private config: PartialRedConfig;

  constructor(config: PartialRedConfig) {
    this.config = config;
    this.db = getDatabase(config.databaseUrl);
    this.compiledCache = new LRUCache<string, CompiledGraph>({
      max: 50,
      ttl: 5 * 60 * 1000,
    });
    this.configCache = new LRUCache<string, GraphConfig>({
      max: 100,
      ttl: 5 * 60 * 1000,
    });
  }

  async initialize(): Promise<void> {
    await this.db.connect();
    console.log('[GraphRegistry] Initialized successfully');
  }

  async getGraph(graphId: string, userId: string): Promise<CompiledGraph> {
    const cacheKey = `${userId}:${graphId}`;
    let compiled = this.compiledCache.get(cacheKey);
    if (compiled) {
      console.log(`[GraphRegistry] Cache hit for graph: ${graphId} (user: ${userId})`);
      return compiled;
    }
    console.log(`[GraphRegistry] Cache miss for graph: ${graphId} (user: ${userId})`);
    const graphConfig = await this.getConfig(graphId, userId);
    await this.validateAccess(graphConfig, userId);
    try {
      compiled = compileGraphFromConfig(graphConfig);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new GraphCompilationError(`Failed to compile graph '${graphId}': ${errorMessage}`, graphId);
    }
    this.compiledCache.set(cacheKey, compiled);
    console.log(`[GraphRegistry] Compiled and cached graph: ${graphId}`);
    this.updateUsageStats(graphId, userId).catch((err) => {
      console.error(`[GraphRegistry] Failed to update usage stats for ${graphId}:`, err);
    });
    return compiled;
  }

  async getConfig(graphId: string, userId: string): Promise<GraphConfig> {
    const cacheKey = `${userId}:${graphId}`;
    const cached = this.configCache.get(cacheKey);
    if (cached) {
      console.log(`[GraphRegistry] Config cache hit: ${graphId}`);
      return cached;
    }
    const doc = await Graph.findOne({
      graphId,
      $or: [{ userId }, { userId: 'system' }],
    });
    if (!doc) throw new GraphNotFoundError(`Graph '${graphId}' not found for user ${userId}`);
    const rawConfig = doc.toObject();
    const executionSource = rawConfig.published
      ? { nodes: rawConfig.published.nodes, edges: rawConfig.published.edges }
      : { nodes: rawConfig.nodes, edges: rawConfig.edges };
    const graphConfig: GraphConfig = {
      ...rawConfig,
      nodes: executionSource.nodes,
      edges: (executionSource.edges || []).map((edge: any) => ({
        ...edge,
        targets: edge.targets instanceof Map ? Object.fromEntries(edge.targets) : edge.targets,
      })),
    };
    this.configCache.set(cacheKey, graphConfig);
    console.log(`[GraphRegistry] Config loaded from DB: ${graphId}`);
    return graphConfig;
  }

  private async validateAccess(graphConfig: GraphConfig, userId: string): Promise<void> {
    if (graphConfig.userId === userId) return;
    if (graphConfig.userId === 'system') {
      const userTier = await this.getUserTier(userId);
      if (userTier > graphConfig.tier) {
        throw new GraphAccessDeniedError(
          `Graph '${graphConfig.graphId}' requires tier ${graphConfig.tier} or higher (user has tier ${userTier})`
        );
      }
      return;
    }
    throw new GraphAccessDeniedError(`Graph '${graphConfig.graphId}' is private and owned by another user`);
  }

  private async getUserTier(userId: string): Promise<number> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mongoose = require('mongoose');
      let User: any;
      if (mongoose.models['User']) {
        User = mongoose.models['User'];
      } else {
        const userSchema = new mongoose.Schema({}, { collection: 'users', strict: false });
        User = mongoose.model('User', userSchema);
      }
      const user = await User.findById(userId).lean();
      if (user && typeof user.accountLevel === 'number') return user.accountLevel;
      return 4;
    } catch (error) {
      console.error('[GraphRegistry] Error loading user tier:', error);
      return 4;
    }
  }

  async getUserGraphs(userId: string): Promise<GraphConfig[]> {
    const userTier = await this.getUserTier(userId);
    const docs = await Graph.find({
      $or: [
        { userId },
        { userId: 'system', tier: { $gte: userTier } },
      ],
    });
    return docs.map((doc: any) => doc.toObject());
  }

  private async updateUsageStats(graphId: string, userId: string): Promise<void> {
    await Graph.updateOne(
      { graphId, $or: [{ userId }, { userId: 'system' }] },
      { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
    ).exec();
  }

  async clearCache(userId?: string): Promise<void> {
    if (userId) {
      let clearedCount = 0;
      for (const key of this.compiledCache.keys()) {
        if (key.startsWith(`${userId}:`)) {
          this.compiledCache.delete(key);
          this.configCache.delete(key);
          clearedCount++;
        }
      }
      console.log(`[GraphRegistry] Cleared cache for user ${userId} (${clearedCount} entries)`);
    } else {
      this.compiledCache.clear();
      this.configCache.clear();
      console.log('[GraphRegistry] Cleared all caches');
    }
  }

  getCacheStats() {
    return {
      compiled: { size: this.compiledCache.size, max: this.compiledCache.max },
      config: { size: this.configCache.size, max: this.configCache.max },
    };
  }

  async subscribeToInvalidations(redisUrl: string): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Redis = require('ioredis');
      const sub = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
      sub.on('error', (err: Error) => {
        console.error('[GraphRegistry] Redis sub error:', err.message);
      });
      await sub.subscribe('graph:invalidate');
      sub.on('message', (_channel: string, graphId: string) => {
        let cleared = 0;
        for (const key of this.compiledCache.keys()) {
          if (key.endsWith(':' + graphId)) {
            this.compiledCache.delete(key);
            cleared++;
          }
        }
        for (const key of this.configCache.keys()) {
          if (key.endsWith(':' + graphId)) {
            this.configCache.delete(key);
            cleared++;
          }
        }
        console.log(`[GraphRegistry] Cache invalidated via pub/sub for graph: ${graphId} (${cleared} entries cleared)`);
      });
      console.log('[GraphRegistry] Subscribed to graph:invalidate channel');
    } catch (err) {
      console.error('[GraphRegistry] Failed to subscribe to invalidations:', err);
    }
  }

  async watchCollection(mongoDb: Db): Promise<void> {
    try {
      const changeStream = mongoDb.collection('graphs').watch(
        [{ $match: { operationType: { $in: ['update', 'replace'] } } }],
        { fullDocument: 'updateLookup' }
      );
      changeStream.on('change', (change: any) => {
        const graphId = change.fullDocument && change.fullDocument.graphId;
        if (!graphId) return;
        let cleared = 0;
        for (const key of this.compiledCache.keys()) {
          if (key.endsWith(':' + graphId)) {
            this.compiledCache.delete(key);
            cleared++;
          }
        }
        for (const key of this.configCache.keys()) {
          if (key.endsWith(':' + graphId)) {
            this.configCache.delete(key);
            cleared++;
          }
        }
        console.log(`[GraphRegistry] Cache invalidated via change stream for graph: ${graphId} (${cleared} entries cleared)`);
      });
      changeStream.on('error', (err: Error) => {
        console.error('[GraphRegistry] Change stream error:', err.message);
      });
      console.log('[GraphRegistry] Watching graphs collection for changes');
    } catch (err) {
      console.error('[GraphRegistry] Failed to start change stream watcher:', err);
    }
  }

  async shutdown(): Promise<void> {
    await this.db.close();
    console.log('[GraphRegistry] Shut down');
  }
}
