import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { 
  LogEntry, 
  LogLevel, 
  LogCategory, 
  Generation,
  ConversationGenerationState,
  RedisKeys,
  TTL 
} from './types';

/**
 * The most fantastic logging system known to man
 * 
 * Features:
 * - Redis pub/sub for real-time log streaming
 * - 30-day TTL for all logs
 * - Generation-level tracking with unique IDs
 * - Thought logs separate from response logs
 * - Color tag support for frontends
 * - Conversation-level aggregated logs
 * - Concurrent generation prevention
 */
export class Logger {
  private redis: Redis;
  
  constructor(redis: Redis) {
    this.redis = redis;
    // Increase max listeners for pub/sub
    this.redis.setMaxListeners(100);
  }
  
  /**
   * Generate a unique generation ID
   */
  generateGenerationId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 11);
    return `gen_${timestamp}_${random}`;
  }
  
  /**
   * Generate a unique log ID
   */
  private generateLogId(): string {
    return `log_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
  
  /**
   * Start a new generation
   * Returns null if a generation is already in progress for this conversation
   * Automatically cleans up stale generations (older than 5 minutes)
   */
  async startGeneration(conversationId: string, generationId?: string): Promise<string | null> {
    const genId = generationId || this.generateGenerationId();
    
    // Check if a generation is already in progress
    const stateKey = RedisKeys.conversationGeneration(conversationId);
    const stateJson = await this.redis.get(stateKey);
    
    if (stateJson) {
      const state: ConversationGenerationState = JSON.parse(stateJson);
      if (state.currentGenerationId) {
        // Check if it's still actually generating
        const genKey = RedisKeys.generation(state.currentGenerationId);
        const genJson = await this.redis.get(genKey);
        if (genJson) {
          const gen: Generation = JSON.parse(genJson);
          if (gen.status === 'generating') {
            // Check if generation is stale (older than 5 minutes)
            const ageMs = Date.now() - gen.startedAt;
            const maxAgeMs = 5 * 60 * 1000; // 5 minutes
            
            if (ageMs > maxAgeMs) {
              console.log(`[Logger] Cleaning up stale generation: ${state.currentGenerationId} (age: ${Math.round(ageMs/1000)}s)`);
              // Mark as error and allow new generation
              await this.failGeneration(state.currentGenerationId, 'Generation timed out (stale)');
            } else {
              console.log(`[Logger] Generation already in progress: ${state.currentGenerationId} (age: ${Math.round(ageMs/1000)}s)`);
              return null; // Reject concurrent generation
            }
          }
        } else {
          // Generation record not found, clean up state
          console.log(`[Logger] Cleaning up orphaned generation state: ${state.currentGenerationId}`);
          state.currentGenerationId = undefined;
          await this.redis.setex(stateKey, TTL.GENERATION, JSON.stringify(state));
        }
      }
    }
    
    // Create generation record
    const generation: Generation = {
      id: genId,
      conversationId,
      status: 'generating',
      startedAt: Date.now(),
    };
    
    await this.redis.setex(
      RedisKeys.generation(genId),
      TTL.GENERATION,
      JSON.stringify(generation)
    );
    
    // Update conversation generation state
    const newState: ConversationGenerationState = {
      conversationId,
      currentGenerationId: genId,
      lastGenerationId: genId,
      generationCount: stateJson ? JSON.parse(stateJson).generationCount + 1 : 1,
    };
    
    await this.redis.setex(
      stateKey,
      TTL.GENERATION,
      JSON.stringify(newState)
    );
    
    // Log generation start
    await this.log({
      level: 'info',
      category: 'generation',
      message: `<cyan>Generation started</cyan>`,
      generationId: genId,
      conversationId,
    });
    
    return genId;
  }
  
  /**
   * Complete a generation
   */
  async completeGeneration(
    generationId: string,
    data: {
      response?: string;
      thinking?: string;
      route?: string;
      toolsUsed?: string[];
      model?: string;
      tokens?: Generation['tokens'];
    }
  ): Promise<void> {
    const genKey = RedisKeys.generation(generationId);
    const genJson = await this.redis.get(genKey);
    
    if (!genJson) {
      console.warn(`[Logger] Generation not found: ${generationId}`);
      return;
    }
    
    const generation: Generation = JSON.parse(genJson);
    generation.status = 'completed';
    generation.completedAt = Date.now();
    generation.response = data.response;
    generation.thinking = data.thinking;
    generation.route = data.route;
    generation.toolsUsed = data.toolsUsed;
    generation.model = data.model;
    generation.tokens = data.tokens;
    
    await this.redis.setex(
      genKey,
      TTL.GENERATION,
      JSON.stringify(generation)
    );
    
    // Clear current generation from conversation state
    const stateKey = RedisKeys.conversationGeneration(generation.conversationId);
    const stateJson = await this.redis.get(stateKey);
    if (stateJson) {
      const state: ConversationGenerationState = JSON.parse(stateJson);
      if (state.currentGenerationId === generationId) {
        state.currentGenerationId = undefined;
        await this.redis.setex(stateKey, TTL.GENERATION, JSON.stringify(state));
      }
    }
    
    // Log completion
    const duration = generation.completedAt - generation.startedAt;
    await this.log({
      level: 'success',
      category: 'generation',
      message: `<green>Generation completed</green> <dim>(${duration}ms)</dim>`,
      generationId,
      conversationId: generation.conversationId,
      metadata: {
        duration,
        tokens: data.tokens,
        route: data.route,
        toolsUsed: data.toolsUsed,
      },
    });

    // Also persist the assistant response as a chat log so UI and DB have the actual text
    if (data.response && typeof data.response === 'string') {
      const maxLen = 10000; // safety cutoff to avoid extremely large single logs
      const truncated = data.response.length > maxLen;
      const respText = truncated ? data.response.slice(0, maxLen) : data.response;

      await this.log({
        level: 'info',
        category: 'chat',
        message: respText,
        generationId,
        conversationId: generation.conversationId,
        metadata: {
          contentLength: data.response.length,
          truncated,
          model: data.model,
        },
      });
    }
  }
  
  /**
   * Fail a generation
   */
  async failGeneration(generationId: string, error: string): Promise<void> {
    const genKey = RedisKeys.generation(generationId);
    const genJson = await this.redis.get(genKey);
    
    if (!genJson) {
      console.warn(`[Logger] Generation not found: ${generationId}`);
      return;
    }
    
    const generation: Generation = JSON.parse(genJson);
    generation.status = 'error';
    generation.completedAt = Date.now();
    generation.error = error;
    
    await this.redis.setex(
      genKey,
      TTL.GENERATION,
      JSON.stringify(generation)
    );
    
    // Clear current generation from conversation state
    const stateKey = RedisKeys.conversationGeneration(generation.conversationId);
    const stateJson = await this.redis.get(stateKey);
    if (stateJson) {
      const state: ConversationGenerationState = JSON.parse(stateJson);
      if (state.currentGenerationId === generationId) {
        state.currentGenerationId = undefined;
        await this.redis.setex(stateKey, TTL.GENERATION, JSON.stringify(state));
      }
    }
    
    // Log error
    await this.log({
      level: 'error',
      category: 'generation',
      message: `<red>Generation failed:</red> ${error}`,
      generationId,
      conversationId: generation.conversationId,
      metadata: { error },
    });
  }
  
  /**
   * Log a message
   */
  async log(params: {
    level: LogLevel;
    category: LogCategory;
    message: string;
    generationId?: string;
    conversationId?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    const logEntry: LogEntry = {
      id: this.generateLogId(),
      timestamp: Date.now(),
      level: params.level,
      category: params.category,
      message: params.message,
      generationId: params.generationId,
      conversationId: params.conversationId,
      metadata: params.metadata,
    };
    
    // Store individual log
    await this.redis.setex(
      RedisKeys.log(logEntry.id),
      TTL.LOG,
      JSON.stringify(logEntry)
    );
    
    // Add to generation logs list
    if (params.generationId) {
      const listKey = RedisKeys.generationLogs(params.generationId);
      await this.redis.rpush(listKey, logEntry.id);
      await this.redis.expire(listKey, TTL.LOG_LIST);
    }
    
    // Add to conversation logs list
    if (params.conversationId) {
      const listKey = RedisKeys.conversationLogs(params.conversationId);
      await this.redis.rpush(listKey, logEntry.id);
      await this.redis.expire(listKey, TTL.LOG_LIST);
    }
    
    // Publish to pub/sub channels
    const logJson = JSON.stringify(logEntry);
    
    // Publish to generation channel
    if (params.generationId) {
      await this.redis.publish(
        RedisKeys.logChannel(params.generationId),
        logJson
      );
    }
    
    // Publish to conversation channel
    if (params.conversationId) {
      await this.redis.publish(
        RedisKeys.conversationLogChannel(params.conversationId),
        logJson
      );
    }
    
    // Publish to all logs channel
    await this.redis.publish(RedisKeys.allLogsChannel, logJson);
  }
  
  /**
   * Log thinking/reasoning separately from responses
   */
  async logThought(params: {
    content: string;
    source: string; // 'router', 'toolPicker', 'chat'
    generationId: string;
    conversationId: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    await this.log({
      level: 'debug',
      category: 'thought',
      message: `<dim>💭 ${params.source} thinking:</dim>\n${params.content}`,
      generationId: params.generationId,
      conversationId: params.conversationId,
      metadata: {
        source: params.source,
        ...params.metadata,
      },
    });
  }
  
  /**
   * Get all logs for a generation
   */
  async getGenerationLogs(generationId: string): Promise<LogEntry[]> {
    const listKey = RedisKeys.generationLogs(generationId);
    const logIds = await this.redis.lrange(listKey, 0, -1);
    
    const logs: LogEntry[] = [];
    for (const logId of logIds) {
      const logJson = await this.redis.get(RedisKeys.log(logId));
      if (logJson) {
        logs.push(JSON.parse(logJson));
      }
    }
    
    return logs;
  }
  
  /**
   * Get all logs for a conversation
   */
  async getConversationLogs(conversationId: string, limit?: number): Promise<LogEntry[]> {
    const listKey = RedisKeys.conversationLogs(conversationId);
    const logIds = await this.redis.lrange(listKey, limit ? -limit : 0, -1);
    
    const logs: LogEntry[] = [];
    for (const logId of logIds) {
      const logJson = await this.redis.get(RedisKeys.log(logId));
      if (logJson) {
        logs.push(JSON.parse(logJson));
      }
    }
    
    return logs;
  }
  
  /**
   * Get generation data
   */
  async getGeneration(generationId: string): Promise<Generation | null> {
    const genJson = await this.redis.get(RedisKeys.generation(generationId));
    return genJson ? JSON.parse(genJson) : null;
  }
  
  /**
   * Get conversation generation state
   */
  async getConversationGenerationState(conversationId: string): Promise<ConversationGenerationState | null> {
    const stateJson = await this.redis.get(RedisKeys.conversationGeneration(conversationId));
    return stateJson ? JSON.parse(stateJson) : null;
  }
  
  /**
   * Subscribe to logs for a generation (real-time streaming)
   */
  async *subscribeToGeneration(generationId: string): AsyncGenerator<LogEntry> {
    const subscriber = this.redis.duplicate();
    subscriber.setMaxListeners(100);
    
    const channel = RedisKeys.logChannel(generationId);
    
    try {
      await subscriber.subscribe(channel);
      
      // Yield existing logs first
      const existingLogs = await this.getGenerationLogs(generationId);
      for (const log of existingLogs) {
        yield log;
      }
      
      // Then stream new logs
      while (true) {
        const message = await new Promise<string | null>((resolve) => {
          subscriber.once('message', (ch: string, msg: string) => {
            if (ch === channel) resolve(msg);
          });
          
          // Timeout after 30 seconds
          setTimeout(() => resolve(null), 30000);
        });
        
        if (message === null) {
          // Check if generation is complete
          const gen = await this.getGeneration(generationId);
          if (!gen || gen.status !== 'generating') {
            break;
          }
          continue;
        }
        
        const logEntry: LogEntry = JSON.parse(message);
        yield logEntry;
        
        // Break if generation complete/error log
        if (logEntry.category === 'generation' && 
            (logEntry.message.includes('completed') || logEntry.message.includes('failed'))) {
          break;
        }
      }
    } finally {
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    }
  }
  
  /**
   * Subscribe to all logs for a conversation (real-time streaming)
   */
  async *subscribeToConversation(conversationId: string): AsyncGenerator<LogEntry> {
    const subscriber = this.redis.duplicate();
    subscriber.setMaxListeners(100);
    
    const channel = RedisKeys.conversationLogChannel(conversationId);
    
    try {
      await subscriber.subscribe(channel);
      
      while (true) {
        const message = await new Promise<string | null>((resolve) => {
          subscriber.once('message', (ch: string, msg: string) => {
            if (ch === channel) resolve(msg);
          });
          
          // Timeout after 60 seconds
          setTimeout(() => resolve(null), 60000);
        });
        
        if (message === null) {
          continue; // Keep alive
        }
        
        const logEntry: LogEntry = JSON.parse(message);
        yield logEntry;
      }
    } finally {
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    }
  }
}
