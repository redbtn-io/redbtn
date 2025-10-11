import Redis from 'ioredis';
import { Logger } from './logger';
import { getDatabase } from '../memory/database';
import type { StoredLog, Generation as DBGeneration } from '../memory/database';
import type { LogEntry, Generation } from './types';

/**
 * Enhanced Logger with MongoDB persistence
 * 
 * Features:
 * - All original Logger functionality (Redis pub/sub, 30-day TTL)
 * - Async batch writes to MongoDB (5-second intervals)
 * - 6-month TTL in MongoDB (automatic cleanup)
 * - Graceful error handling (Redis always succeeds even if MongoDB fails)
 * - Automatic flush on shutdown
 */
export class PersistentLogger extends Logger {
  private db = getDatabase();
  private logQueue: StoredLog[] = [];
  private generationQueue: Map<string, DBGeneration> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL_MS = 5000; // 5 seconds
  private readonly MAX_BATCH_SIZE = 100;
  private nodeId: string;

  constructor(redis: Redis, nodeId: string = 'default') {
    super(redis);
    this.nodeId = nodeId;
    this.startFlushInterval();
  }

  /**
   * Start the automatic flush interval
   */
  private startFlushInterval(): void {
    this.flushInterval = setInterval(async () => {
      await this.flushQueues();
    }, this.FLUSH_INTERVAL_MS);
  }

  /**
   * Flush queued logs and generations to MongoDB
   */
  private async flushQueues(): Promise<void> {
    // Flush logs
    if (this.logQueue.length > 0) {
      const batch = this.logQueue.splice(0, this.logQueue.length);
      try {
        await this.db.storeLogs(batch);
        console.log(`[PersistentLogger] Persisted ${batch.length} logs to MongoDB`);
      } catch (error) {
        console.error('[PersistentLogger] Failed to persist logs to MongoDB:', error);
        // Don't re-queue to avoid infinite growth on persistent failures
      }
    }

    // Flush generations
    if (this.generationQueue.size > 0) {
      const generations = Array.from(this.generationQueue.values());
      this.generationQueue.clear();

      for (const gen of generations) {
        try {
          // Check if generation exists, update if it does, insert if not
          const existing = await this.db.getGeneration(gen.generationId);
          if (existing) {
            await this.db.updateGenerationStatus(gen.generationId, gen.status, {
              endTime: gen.endTime,
              duration: gen.duration,
              error: gen.error,
            });
          } else {
            await this.db.storeGeneration(gen);
          }
        } catch (error) {
          console.error(`[PersistentLogger] Failed to persist generation ${gen.generationId}:`, error);
        }
      }
      
      if (generations.length > 0) {
        console.log(`[PersistentLogger] Persisted ${generations.length} generation(s) to MongoDB`);
      }
    }
  }

  /**
   * Convert LogEntry to StoredLog format
   */
  private convertToStoredLog(logEntry: LogEntry): StoredLog {
    return {
      logId: logEntry.id,
      generationId: logEntry.generationId,
      conversationId: logEntry.conversationId,
      level: this.mapLogLevel(logEntry.level),
      category: logEntry.category,
      message: logEntry.message,
      timestamp: new Date(logEntry.timestamp),
      nodeId: this.nodeId,
      metadata: logEntry.metadata,
    };
  }

  /**
   * Map log levels to StoredLog format
   */
  private mapLogLevel(level: string): 'info' | 'warn' | 'error' | 'debug' | 'trace' {
    const mapped: Record<string, 'info' | 'warn' | 'error' | 'debug' | 'trace'> = {
      'info': 'info',
      'warn': 'warn',
      'error': 'error',
      'debug': 'debug',
      'trace': 'trace',
      // Fallback
      'log': 'info',
    };
    return mapped[level] || 'info';
  }

  /**
   * Override log method to also queue for MongoDB persistence
   */
  async log(params: {
    level: string;
    category: string;
    message: string;
    generationId?: string;
    conversationId?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    // Call parent method (writes to Redis, publishes to pub/sub)
    await super.log(params as any);

    // Queue for MongoDB persistence
    try {
      const storedLog = this.convertToStoredLog({
        id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        timestamp: Date.now(),
        level: params.level,
        category: params.category,
        message: params.message,
        generationId: params.generationId,
        conversationId: params.conversationId,
        metadata: params.metadata,
      } as LogEntry);

      this.logQueue.push(storedLog);

      // Flush immediately if queue is too large
      if (this.logQueue.length >= this.MAX_BATCH_SIZE) {
        await this.flushQueues();
      }
    } catch (error) {
      console.error('[PersistentLogger] Failed to queue log for MongoDB:', error);
      // Don't throw - Redis write already succeeded
    }
  }

  /**
   * Override startGeneration to also track in MongoDB
   */
  async startGeneration(conversationId: string, generationId?: string): Promise<string | null> {
    const genId = await super.startGeneration(conversationId, generationId);
    
    if (genId) {
      try {
        // Queue generation for MongoDB
        const dbGeneration: DBGeneration = {
          generationId: genId,
          conversationId,
          status: 'pending',
          nodeId: this.nodeId,
          startTime: new Date(),
        };
        this.generationQueue.set(genId, dbGeneration);
      } catch (error) {
        console.error('[PersistentLogger] Failed to queue generation for MongoDB:', error);
        // Don't throw - Redis write already succeeded
      }
    }
    
    return genId;
  }

  /**
   * Override completeGeneration to track in MongoDB
   */
  async completeGeneration(
    generationId: string,
    data: {
      response?: string;
      thinking?: string;
      route?: string;
      toolsUsed?: string[];
      model?: string;
      tokens?: any;
    }
  ): Promise<void> {
    await super.completeGeneration(generationId, data);
    
    try {
      const existing = this.generationQueue.get(generationId);
      if (existing) {
        existing.status = 'completed';
        existing.endTime = new Date();
        existing.duration = existing.endTime.getTime() - existing.startTime.getTime();
        if (data.tokens) {
          existing.tokensUsed = data.tokens.total || 0;
        }
        existing.model = data.model;
      } else {
        // Create completed entry
        this.generationQueue.set(generationId, {
          generationId,
          conversationId: '',
          status: 'completed',
          nodeId: this.nodeId,
          model: data.model,
          startTime: new Date(),
          endTime: new Date(),
          duration: 0,
          tokensUsed: data.tokens?.total || 0,
        });
      }
      
      // Flush immediately on completion
      await this.flushQueues();
    } catch (error) {
      console.error('[PersistentLogger] Failed to complete generation in MongoDB:', error);
    }
  }

  /**
   * Override failGeneration to track in MongoDB
   */
  async failGeneration(generationId: string, error: string): Promise<void> {
    await super.failGeneration(generationId, error);
    
    try {
      const existing = this.generationQueue.get(generationId);
      if (existing) {
        existing.status = 'failed';
        existing.endTime = new Date();
        existing.duration = existing.endTime.getTime() - existing.startTime.getTime();
        existing.error = error;
      } else {
        // Create failed entry
        this.generationQueue.set(generationId, {
          generationId,
          conversationId: '',
          status: 'failed',
          nodeId: this.nodeId,
          startTime: new Date(),
          endTime: new Date(),
          duration: 0,
          error,
        });
      }
      
      // Flush immediately on failure
      await this.flushQueues();
    } catch (error) {
      console.error('[PersistentLogger] Failed to mark generation as failed in MongoDB:', error);
    }
  }

  /**
   * Shutdown the logger and flush all pending writes
   */
  async shutdown(): Promise<void> {
    console.log('[PersistentLogger] Shutting down...');
    
    // Stop the flush interval
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    
    // Flush any remaining queued data
    await this.flushQueues();
    
    // Close database connection
    await this.db.close();
    
    console.log('[PersistentLogger] Shutdown complete');
  }
}
