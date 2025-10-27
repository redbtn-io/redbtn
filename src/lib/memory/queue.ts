import Redis from 'ioredis';

/**
 * Message Queue - Manages in-progress message generation state in Redis
 * Allows reconnecting to ongoing generations and tracking completion status
 */

export interface MessageGenerationState {
  conversationId: string;
  messageId: string;
  status: 'generating' | 'completed' | 'error';
  content: string;
  thinking?: string; // Accumulated thinking/reasoning content
  toolEvents?: any[]; // Accumulated tool events for reconnection replay
  startedAt: number;
  completedAt?: number;
  error?: string;
  currentStatus?: {
    action: string;
    description?: string;
  };
  metadata?: {
    model?: string;
    tokens?: {
      input?: number;
      output?: number;
      total?: number;
    };
  };
}

export class MessageQueue {
  private redis: Redis;
  private readonly STATE_TTL = 3600; // 1 hour TTL for message states
  private readonly CONTENT_KEY_PREFIX = 'message:generating:';
  private readonly INDEX_KEY_PREFIX = 'conversation:generating:';
  private readonly PUBSUB_PREFIX = 'message:stream:';
  private readonly STREAM_READY_PREFIX = 'stream:ready:';

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Signal that a stream client is connected and ready to receive events
   */
  async markStreamReady(messageId: string): Promise<void> {
    const key = `${this.STREAM_READY_PREFIX}${messageId}`;
    await this.redis.setex(key, 60, '1'); // 60 second TTL
    console.log(`[MessageQueue] Stream marked ready for ${messageId}`);
  }

  /**
   * Wait for stream client to be ready before starting generation
   * Returns true if ready, false if timeout
   */
  async waitForStreamReady(messageId: string, timeoutMs: number = 5000): Promise<boolean> {
    const key = `${this.STREAM_READY_PREFIX}${messageId}`;
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const ready = await this.redis.get(key);
      if (ready === '1') {
        console.log(`[MessageQueue] Stream is ready for ${messageId}`);
        return true;
      }
      // Wait 50ms before checking again
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    console.warn(`[MessageQueue] Timeout waiting for stream ready for ${messageId}`);
    return false; // Start anyway after timeout
  }

  /**
   * Start tracking a new message generation
   */
  async startGeneration(conversationId: string, messageId: string): Promise<void> {
    const state: MessageGenerationState = {
      conversationId,
      messageId,
      status: 'generating',
      content: '',
      startedAt: Date.now(),
      currentStatus: {
        action: 'initializing',
        description: 'Starting generation'
      }
    };

    const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
    await this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
    
    // Add to conversation's generating messages index
    await this.redis.sadd(`${this.INDEX_KEY_PREFIX}${conversationId}`, messageId);
    await this.redis.expire(`${this.INDEX_KEY_PREFIX}${conversationId}`, this.STATE_TTL);

    // Publish initial status event so frontend knows generation started
    await this.redis.publish(
      `${this.PUBSUB_PREFIX}${messageId}`,
      JSON.stringify({ type: 'status', action: 'initializing', description: 'Starting generation' })
    );

    console.log(`[MessageQueue] Started generation tracking: ${messageId}`);
  }

  /**
   * Append content to a generating message (called as tokens stream in)
   */
  async appendContent(messageId: string, chunk: string): Promise<void> {
    const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
    const stateJson = await this.redis.get(key);
    
    if (!stateJson) {
      console.warn(`[MessageQueue] Cannot append to non-existent message: ${messageId}`);
      return;
    }

    const state: MessageGenerationState = JSON.parse(stateJson);
    state.content += chunk;
    
    await this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
    
    // Publish chunk to pub/sub channel for real-time streaming
    await this.redis.publish(
      `${this.PUBSUB_PREFIX}${messageId}`,
      JSON.stringify({ type: 'chunk', content: chunk })
    );
  }

  /**
   * Mark message generation as completed
   */
  async completeGeneration(
    messageId: string, 
    metadata?: MessageGenerationState['metadata']
  ): Promise<void> {
    const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
    const stateJson = await this.redis.get(key);
    
    if (!stateJson) {
      console.warn(`[MessageQueue] Cannot complete non-existent message: ${messageId}`);
      return;
    }

    const state: MessageGenerationState = JSON.parse(stateJson);
    state.status = 'completed';
    state.completedAt = Date.now();
    if (metadata) {
      state.metadata = metadata;
    }
    
    await this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
    
    // Remove from generating index
    await this.redis.srem(`${this.INDEX_KEY_PREFIX}${state.conversationId}`, messageId);

    // Publish completion event
    await this.redis.publish(
      `${this.PUBSUB_PREFIX}${messageId}`,
      JSON.stringify({ type: 'complete', metadata })
    );

    console.log(`[MessageQueue] Completed generation: ${messageId} (${state.content.length} chars)`);
  }

  /**
   * Publish tool status indicator (searching, scraping, etc.)
   */
  async publishToolStatus(messageId: string, toolInfo: { status: string; action: string }): Promise<void> {
    console.log(`[MessageQueue] publishToolStatus called for ${messageId}:`, toolInfo);
    
    // Store in state so SSE connection can retrieve it
    const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
    const stateJson = await this.redis.get(key);
    
    if (stateJson) {
      const state: MessageGenerationState = JSON.parse(stateJson);
      console.log(`[MessageQueue] Current state before update:`, { currentStatus: state.currentStatus });
      
      state.currentStatus = {
        action: toolInfo.action,
        description: toolInfo.status
      };
      
      await this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
      console.log(`[MessageQueue] Updated state.currentStatus to:`, state.currentStatus);
    } else {
      console.warn(`[MessageQueue] No state found for ${messageId}, cannot store tool status`);
    }
    
    // Publish tool status event
    await this.redis.publish(
      `${this.PUBSUB_PREFIX}${messageId}`,
      JSON.stringify({ type: 'tool_status', ...toolInfo })
    );
    
    console.log(`[MessageQueue] Published tool_status event to pub/sub for ${messageId}`);
  }

  /**
   * Publish general status update (routing, thinking, processing, etc.)
   */
  async publishStatus(messageId: string, status: { action: string; description?: string }): Promise<void> {
    console.log(`[MessageQueue] Publishing status for ${messageId}:`, status.action);
    
    // Store in state so SSE connection can retrieve it
    const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
    const stateJson = await this.redis.get(key);
    
    if (stateJson) {
      const state: MessageGenerationState = JSON.parse(stateJson);
      state.currentStatus = status;
      await this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
    }
    
    // Publish status event
    await this.redis.publish(
      `${this.PUBSUB_PREFIX}${messageId}`,
      JSON.stringify({ type: 'status', ...status })
    );
  }

  /**
   * Publish thinking/reasoning content chunk by chunk
   */
  async publishThinkingChunk(messageId: string, chunk: string): Promise<void> {
    // Accumulate thinking content in Redis state for reconnection
    const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
    const stateJson = await this.redis.get(key);
    
    if (stateJson) {
      const state: MessageGenerationState = JSON.parse(stateJson);
      state.thinking = (state.thinking || '') + chunk;
      await this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
    }
    
    // Silent - too noisy to log each chunk
    await this.redis.publish(
      `${this.PUBSUB_PREFIX}${messageId}`,
      JSON.stringify({ type: 'chunk', content: chunk, thinking: true })
    );
  }

  /**
   * Publish thinking complete event (when </think> tag is closed)
   */
  async publishThinkingComplete(messageId: string): Promise<void> {
    console.log('[MessageQueue] Publishing thinking complete event for', messageId);
    await this.redis.publish(
      `${this.PUBSUB_PREFIX}${messageId}`,
      JSON.stringify({ type: 'thinkingComplete' })
    );
  }

  /**
   * Publish tool event to Redis pub/sub
   * Simple wrapper that doesn't require ToolEvent types
   */
  async publishToolEvent(messageId: string, event: any): Promise<void> {
    // Accumulate tool events in Redis state for reconnection
    const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
    const stateJson = await this.redis.get(key);
    
    if (stateJson) {
      const state: MessageGenerationState = JSON.parse(stateJson);
      if (!state.toolEvents) {
        state.toolEvents = [];
      }
      state.toolEvents.push(event);
      await this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
    }
    
    // Also publish to real-time pub/sub
    await this.redis.publish(
      `${this.PUBSUB_PREFIX}${messageId}`,
      JSON.stringify({ type: 'tool_event', event })
    );
    
    if (event.type !== 'tool_progress') {
      console.log(`[MessageQueue] Published tool event: ${event.type} for ${event.toolName || event.toolId}`);
    }
  }

  /**
   * Mark message generation as failed
   */
  async failGeneration(messageId: string, error: string): Promise<void> {
    const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
    const stateJson = await this.redis.get(key);
    
    if (!stateJson) {
      console.warn(`[MessageQueue] Cannot fail non-existent message: ${messageId}`);
      return;
    }

    const state: MessageGenerationState = JSON.parse(stateJson);
    state.status = 'error';
    state.error = error;
    state.completedAt = Date.now();
    
    await this.redis.setex(key, this.STATE_TTL, JSON.stringify(state));
    
    // Remove from generating index
    await this.redis.srem(`${this.INDEX_KEY_PREFIX}${state.conversationId}`, messageId);

    // Publish error event
    await this.redis.publish(
      `${this.PUBSUB_PREFIX}${messageId}`,
      JSON.stringify({ type: 'error', error })
    );

    console.error(`[MessageQueue] Failed generation: ${messageId} - ${error}`);
  }

  /**
   * Get current state of a generating message
   */
  async getMessageState(messageId: string): Promise<MessageGenerationState | null> {
    const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
    const stateJson = await this.redis.get(key);
    
    if (!stateJson) {
      return null;
    }

    return JSON.parse(stateJson);
  }

  /**
   * Get all generating messages for a conversation
   */
  async getGeneratingMessages(conversationId: string): Promise<MessageGenerationState[]> {
    const messageIds = await this.redis.smembers(`${this.INDEX_KEY_PREFIX}${conversationId}`);
    
    if (messageIds.length === 0) {
      return [];
    }

    const states: MessageGenerationState[] = [];
    for (const messageId of messageIds) {
      const state = await this.getMessageState(messageId);
      if (state) {
        states.push(state);
      }
    }

    return states;
  }

  /**
   * Clean up completed/failed message state
   */
  async cleanupMessage(messageId: string): Promise<void> {
    const key = `${this.CONTENT_KEY_PREFIX}${messageId}`;
    await this.redis.del(key);
  }

  /**
   * Subscribe to a message stream via Redis pub/sub
   * Returns an async generator that yields chunks, completion, or errors
   */
  async *subscribeToMessage(messageId: string): AsyncGenerator<{
    type: 'init' | 'chunk' | 'status' | 'thinking' | 'complete' | 'error' | 'tool_status' | 'tool_event';
    content?: string;
    thinking?: boolean; // Flag for chunk events to indicate thinking/reasoning content
    existingContent?: string;
    metadata?: MessageGenerationState['metadata'];
    error?: string;
    action?: string;
    description?: string;
    status?: string;
    event?: any;
  }> {
    // First, get any existing content
    const state = await this.getMessageState(messageId);
    if (!state) {
      throw new Error(`Message ${messageId} not found`);
    }

    // Yield existing content if any
    if (state.content) {
      yield { type: 'init', existingContent: state.content };
    }
    
    // Yield current status if any (this is the key fix!)
    if (state.currentStatus) {
      console.log(`[MessageQueue] Sending stored status to new SSE connection: ${state.currentStatus.action}`);
      yield { 
        type: state.currentStatus.action.includes('search') || state.currentStatus.action.includes('scrape') || state.currentStatus.action.includes('command') 
          ? 'tool_status' 
          : 'status',
        action: state.currentStatus.action,
        description: state.currentStatus.description,
        status: state.currentStatus.description
      };
    }

    // If already completed, just send completion event
    if (state.status === 'completed') {
      yield { type: 'complete', metadata: state.metadata };
      return;
    }

    if (state.status === 'error') {
      yield { type: 'error', error: state.error };
      return;
    }

    // Subscribe to pub/sub for new chunks
    const subscriber = this.redis.duplicate();
    // Increase max listeners to prevent warnings when multiple clients connect
    subscriber.setMaxListeners(50);
    const channel = `${this.PUBSUB_PREFIX}${messageId}`;
    const getState = this.getMessageState.bind(this);
    let cleanedUp = false;
    
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
        console.log(`[MessageQueue] Cleaned up subscriber for ${messageId}`);
      } catch (e) {
        // Ignore cleanup errors
      }
    };

    try {
      await subscriber.subscribe(channel);
      console.log(`[MessageQueue] Redis subscription established for ${messageId}`);

      // Create a promise-based message handler
      const messageIterator = async function* (sub: Redis) {
        while (true) {
          const message = await new Promise<string | null>((resolve) => {
            sub.once('message', (ch: string, msg: string) => {
              if (ch === channel) {
                resolve(msg);
              }
            });
            // Timeout after 30 seconds of no activity
            setTimeout(() => resolve(null), 30000);
          });

          if (message === null) {
            // Timeout - check if generation completed
            const currentState = await getState(messageId);
            if (!currentState || currentState.status !== 'generating') {
              break;
            }
            continue;
          }

          yield message;
        }
      }(subscriber);

      for await (const message of messageIterator) {
        const event = JSON.parse(message);
        
        if (event.type === 'chunk') {
          // Forward chunk events with thinking property if present
          yield { type: 'chunk', content: event.content, thinking: event.thinking };
        } else if (event.type === 'status') {
          yield { type: 'status', action: event.action, description: event.description };
        } else if (event.type === 'thinking') {
          yield { type: 'thinking', content: event.content };
        } else if (event.type === 'tool_status') {
          yield { type: 'tool_status', status: event.status, action: event.action };
        } else if (event.type === 'tool_event') {
          yield { type: 'tool_event', event: event.event };
        } else if (event.type === 'complete') {
          yield { type: 'complete', metadata: event.metadata };
          break;
        } else if (event.type === 'error') {
          yield { type: 'error', error: event.error };
          break;
        }
      }
    } finally {
      await cleanup();
    }
  }
}
