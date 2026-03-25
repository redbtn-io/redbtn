/**
 * ConversationPublisher -- publishes messages and events to a conversation stream.
 *
 * Unlike RunPublisher (which manages run lifecycle state), this is a pure event
 * emitter. Multiple publishers can target the same conversation simultaneously.
 *
 * Events are published to:
 * - Redis pub/sub channel: conversation:stream:{conversationId}
 * - Redis list: conversation:events:{conversationId} (for replay)
 *
 * Messages can optionally be persisted to MongoDB via the conversation model.
 */

import type Redis from 'ioredis';
import { ConversationKeys, ConversationConfig, type ConversationEvent } from './types';

export interface ConversationPublisherOptions {
  redis: Redis;
  conversationId: string;
  userId?: string;
  eventsTtl?: number;
}

export class ConversationPublisher {
  private readonly redis: Redis;
  private readonly conversationId: string;
  private readonly userId?: string;
  private readonly channel: string;
  private readonly eventsKey: string;
  private readonly ttl: number;

  constructor(options: ConversationPublisherOptions) {
    this.redis = options.redis;
    this.conversationId = options.conversationId;
    this.userId = options.userId;
    this.channel = ConversationKeys.stream(options.conversationId);
    this.eventsKey = ConversationKeys.events(options.conversationId);
    this.ttl = options.eventsTtl ?? ConversationConfig.EVENTS_TTL_SECONDS;
  }

  /**
   * Push a complete message to the conversation.
   * Published immediately and optionally persisted to MongoDB.
   */
  async pushMessage(params: {
    role: 'user' | 'assistant' | 'system';
    content: string;
    messageId?: string;
    metadata?: Record<string, unknown>;
    persist?: boolean;
  }): Promise<string> {
    const messageId = params.messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await this.publish({
      type: 'message',
      messageId,
      role: params.role,
      content: params.content,
      metadata: params.metadata,
      timestamp: Date.now(),
    });

    // Persist to MongoDB if requested (default: true)
    if (params.persist !== false) {
      await this.persistMessage({
        messageId,
        role: params.role,
        content: params.content,
        metadata: params.metadata,
      });
    }

    return messageId;
  }

  /** Begin streaming a message -- UI shows an empty bubble */
  async startMessage(messageId: string, role: string = 'assistant'): Promise<void> {
    await this.publish({
      type: 'message_start',
      messageId,
      role,
      timestamp: Date.now(),
    });
  }

  /** Stream a chunk of content to an active message */
  async streamChunk(messageId: string, content: string, thinking?: boolean): Promise<void> {
    await this.publish({
      type: 'message_chunk',
      messageId,
      content,
      thinking: thinking || false,
      timestamp: Date.now(),
    });
  }

  /** Complete a streaming message */
  async completeMessage(messageId: string, finalContent?: string): Promise<void> {
    await this.publish({
      type: 'message_complete',
      messageId,
      finalContent,
      timestamp: Date.now(),
    });
  }

  // ── Run-aware streaming methods ──
  // Used by RunPublisher to forward events to the conversation stream.

  /** Signal a run has started in this conversation */
  async publishRunStart(runId: string, messageId: string, graphId: string, graphName: string): Promise<void> {
    await this.publish({
      type: 'run_start',
      runId,
      messageId,
      graphId,
      graphName,
      timestamp: Date.now(),
    });
  }

  /** Stream a thinking/reasoning chunk from a run */
  async streamThinking(runId: string, messageId: string, content: string): Promise<void> {
    await this.publish({
      type: 'thinking_chunk',
      runId,
      messageId,
      content,
      timestamp: Date.now(),
    });
  }

  /** Stream a content chunk from a run */
  async streamContent(runId: string, messageId: string, content: string): Promise<void> {
    await this.publish({
      type: 'content_chunk',
      runId,
      messageId,
      content,
      timestamp: Date.now(),
    });
  }

  /** Publish a tool event from a run */
  async publishToolEvent(runId: string, event: {
    type: 'tool_start' | 'tool_progress' | 'tool_complete' | 'tool_error';
    toolId: string;
    toolName: string;
    toolType: string;
    input?: unknown;
    step?: string;
    progress?: number;
    data?: Record<string, unknown>;
    result?: unknown;
    metadata?: Record<string, unknown>;
    error?: string;
    timestamp: number;
  }): Promise<void> {
    await this.publish({
      type: 'tool_event',
      runId,
      event,
      timestamp: Date.now(),
    });
  }

  /** Signal a run has completed in this conversation */
  async publishRunComplete(runId: string, messageId: string, finalContent?: string): Promise<void> {
    await this.publish({
      type: 'run_complete',
      runId,
      messageId,
      finalContent,
      timestamp: Date.now(),
    });
  }

  /** Signal a run has failed in this conversation */
  async publishRunError(runId: string, messageId: string, error: string): Promise<void> {
    await this.publish({
      type: 'run_error',
      runId,
      messageId,
      error,
      timestamp: Date.now(),
    });
  }

  /** Show/hide typing indicator */
  async setTyping(isTyping: boolean, sourceRunId?: string): Promise<void> {
    await this.publish({
      type: 'typing',
      isTyping,
      sourceRunId,
      timestamp: Date.now(),
    });
  }

  /** Send a status update */
  async status(action: string, description?: string): Promise<void> {
    await this.publish({
      type: 'status',
      action,
      description,
      timestamp: Date.now(),
    });
  }

  // -- Internal --

  private async publish(event: ConversationEvent): Promise<void> {
    const json = JSON.stringify(event);
    // Publish to pub/sub for live listeners
    await this.redis.publish(this.channel, json);
    // Store in list for replay on reconnection
    await this.redis.rpush(this.eventsKey, json);
    await this.redis.expire(this.eventsKey, this.ttl);
  }

  private async persistMessage(params: {
    messageId: string;
    role: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      // Use mongoose to persist to the conversation
      // Import dynamically to avoid circular deps and work in both webapp and worker
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1) return; // Skip if not connected

      const db = mongoose.connection.db;
      if (!db) return;

      // Add message to the conversation's messages array
      const { ObjectId } = mongoose.Types;
      const filter = ObjectId.isValid(this.conversationId)
        ? { _id: new ObjectId(this.conversationId) }
        : { conversationId: this.conversationId };

      await db.collection('user_conversations').updateOne(
        filter,
        {
          $push: {
            messages: {
              messageId: params.messageId,
              role: params.role,
              content: params.content,
              metadata: params.metadata,
              timestamp: new Date(),
            },
          },
          $set: {
            lastMessageAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );

      // Emit stored event
      await this.publish({
        type: 'message_stored',
        messageId: params.messageId,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('[ConversationPublisher] Failed to persist message:', err);
      // Non-fatal -- the message was still published to the stream
    }
  }
}

export function createConversationPublisher(
  options: ConversationPublisherOptions
): ConversationPublisher {
  return new ConversationPublisher(options);
}
