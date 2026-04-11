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
 *
 * Archive side-channel:
 * - After every publish(), enqueues a BullMQ job to `conversation-archive` queue
 *   (unless ARCHIVE_QUEUE_DISABLED=true). Each job has a dedup ID of
 *   `{conversationId}:{seq}`. Attachment events have their base64 payload stripped
 *   before enqueueing — only the reference (fileId/url) is archived.
 */

import type Redis from 'ioredis';
import { ConversationKeys, ConversationConfig, type ConversationEvent } from './types';

// ---------------------------------------------------------------------------
// Module-level singleton BullMQ Queue instances (C-1 fix)
// One Queue per (name, prefix) pair — shared across all ConversationPublisher instances.
//
// IMPORTANT: BullMQ Queue requires a connection config object (host/port/password),
// NOT an existing ioredis instance. We parse REDIS_URL once and reuse the config.
// Passing an ioredis instance directly causes queue.add() to fail silently.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Queue: _BullQueue } = require('bullmq');
const _archiveQueues = new Map<string, InstanceType<typeof _BullQueue>>();

/**
 * Parse REDIS_URL into a BullMQ-compatible connection config object.
 * BullMQ needs { host, port, password } — not an ioredis instance.
 */
function parseBullMQConnectionFromEnv(): { host: string; port: number; password?: string; username?: string; db?: number; tls?: object } {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  try {
    const parsed = new URL(url);
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const db = parsed.pathname && parsed.pathname !== '/' ? parseInt(parsed.pathname.slice(1), 10) : 0;
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      ...(password && { password }),
      ...(username && { username }),
      ...(db && { db }),
      ...(parsed.protocol === 'rediss:' && { tls: {} }),
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

let _bullMQConnection: ReturnType<typeof parseBullMQConnectionFromEnv> | null = null;

function getBullMQConnection(): ReturnType<typeof parseBullMQConnectionFromEnv> {
  if (!_bullMQConnection) {
    _bullMQConnection = parseBullMQConnectionFromEnv();
  }
  return _bullMQConnection;
}

function getArchiveQueue(name: string, _redis: unknown, prefix: string): InstanceType<typeof _BullQueue> {
  const key = `${prefix}:${name}`;
  if (!_archiveQueues.has(key)) {
    _archiveQueues.set(key, new _BullQueue(name, { connection: getBullMQConnection(), prefix }));
  }
  return _archiveQueues.get(key)!;
}

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

  /**
   * Begin streaming a message -- UI shows an empty bubble.
   * Optional metadata (e.g., `{ audio: true }`) is passed through to the
   * subscriber so the client can render role/content-specific decorations
   * like a mic icon for voice messages.
   */
  async startMessage(
    messageId: string,
    role: string = 'assistant',
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.publish({
      type: 'message_start',
      messageId,
      role,
      ...(metadata ? { metadata } : {}),
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

  /**
   * Publish an attachment event to the conversation stream.
   * Called by RunPublisher when a file is produced or received during a run.
   * The chat UI uses this to render inline previews without polling.
   */
  async publishAttachment(runId: string, event: {
    type: 'attachment';
    attachmentId: string;
    kind: 'image' | 'video' | 'audio' | 'document' | 'file';
    mimeType: string;
    filename: string;
    size: number;
    fileId?: string;
    url?: string;
    base64?: string;
    caption?: string;
    timestamp: number;
  }, messageId?: string): Promise<void> {
    await this.publish({
      type: 'attachment',
      runId,
      // W-4: include messageId so the archiver can associate this attachment
      // with the correct in-flight message instead of silently dropping it.
      ...(messageId ? { messageId } : {}),
      attachmentId: event.attachmentId,
      kind: event.kind,
      mimeType: event.mimeType,
      filename: event.filename,
      size: event.size,
      fileId: event.fileId,
      url: event.url,
      base64: event.base64,
      caption: event.caption,
      timestamp: event.timestamp,
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

  // ── Live/stream-specific methods ──

  /** Publish a base64 audio chunk (ephemeral — not stored in replay or archive) */
  async publishAudioChunk(messageId: string, data: string, mimeType: string, connectionId?: string): Promise<void> {
    await this.publish({
      type: 'audio_chunk',
      messageId,
      data,
      mimeType,
      connectionId,
      timestamp: Date.now(),
    });
  }

  /** Publish input transcription (user speech-to-text) */
  async publishInputTranscription(text: string, messageId?: string, isFinal?: boolean): Promise<void> {
    await this.publish({
      type: 'input_transcription',
      text,
      messageId,
      isFinal,
      timestamp: Date.now(),
    });
  }

  /** Publish output transcription (AI speech-to-text) */
  async publishOutputTranscription(messageId: string, text: string): Promise<void> {
    await this.publish({
      type: 'output_transcription',
      messageId,
      text,
      timestamp: Date.now(),
    });
  }

  /** Signal end of a live turn */
  async publishTurnComplete(messageId?: string, connectionId?: string): Promise<void> {
    await this.publish({
      type: 'turn_complete',
      messageId,
      connectionId,
      timestamp: Date.now(),
    });
  }

  /** Signal barge-in / interruption */
  async publishInterrupted(messageId?: string): Promise<void> {
    await this.publish({
      type: 'interrupted',
      messageId,
      timestamp: Date.now(),
    });
  }

  // -- Internal --

  /** Ephemeral event types that should NOT be stored in replay list or archived */
  private static readonly EPHEMERAL_TYPES = new Set(['audio_chunk']);

  private async publish(event: ConversationEvent): Promise<void> {
    const json = JSON.stringify(event);
    const isEphemeral = ConversationPublisher.EPHEMERAL_TYPES.has(event.type);
    // Publish to pub/sub for live listeners (always)
    await this.redis.publish(this.channel, json);
    // Skip replay list and archive for ephemeral events (e.g. audio chunks)
    if (!isEphemeral) {
      await this.redis.rpush(this.eventsKey, json);
      await this.redis.expire(this.eventsKey, this.ttl);
      this._enqueueArchive(event).catch(() => {});
    }
  }

  /**
   * Enqueue a conversation archive job.
   *
   * No-op when ARCHIVE_QUEUE_DISABLED=true (for local dev without the
   * webapp archiver running). Attachment events have their base64 payload
   * stripped -- only the reference (fileId/url) is archived.
   */
  private async _enqueueArchive(event: ConversationEvent): Promise<void> {
    if (process.env.ARCHIVE_QUEUE_DISABLED === 'true') return;
    try {
      const seqKey = `archive:seq:conv:${this.conversationId}`;
      const seq = await this.redis.incr(seqKey);
      // Expire the seq counter after the events TTL
      if (seq === 1) {
        await this.redis.expire(seqKey, this.ttl);
      }
      // Strip base64 from attachment events -- archive references only
      let archiveEvent: Record<string, unknown> = event as unknown as Record<string, unknown>;
      if ((event as any).type === 'attachment' && (archiveEvent as any).base64) {
        const { base64: _stripped, ...rest } = archiveEvent;
        archiveEvent = { ...rest, base64Stripped: true };
      }
      const jobData = {
        type: 'conversation',
        conversationId: this.conversationId,
        userId: this.userId,
        seq,
        event: archiveEvent,
        timestamp: Date.now(),
      };
      // Use module-level singleton Queue to avoid per-event connection churn (C-1).
      const prefix = process.env.BULLMQ_PREFIX ?? 'bull';
      const queue = getArchiveQueue('conversation-archive', this.redis, prefix);
      await queue.add('archive', jobData, {
        // BullMQ does not allow colons in jobIds — use underscore separator
        jobId: `${this.conversationId}_${seq}`,
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 86400 },
      });
    } catch (_err) {
      // Silently swallow -- archiving is a side-channel, never fatal
    }
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

      // Use `id` (not `messageId`) so the archiver's $pull-then-$push dedup
      // correctly removes any inline-written entry before writing its version.
      // Without this, both the inline path (here) and the archiver would push
      // separate entries for the same message.
      await db.collection('user_conversations').updateOne(
        filter,
        {
          $pull: { messages: { id: params.messageId } } as any,
        }
      );
      await db.collection('user_conversations').updateOne(
        filter,
        {
          $push: {
            messages: {
              id: params.messageId,
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
