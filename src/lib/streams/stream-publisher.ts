/**
 * StreamEventPublisher — pub/sub event publisher for realtime stream sessions.
 *
 * Mirrors the pattern of RunPublisher and ConversationPublisher:
 * - Publish events to a Redis pub/sub channel (stream:channel:{sessionId})
 * - Store events in a Redis list (stream:events:{sessionId}) for replay on reconnect
 * - Maintain session state JSON (stream:state:{sessionId})
 * - Publish async subgraph results to a separate result channel (stream:result:{sessionId})
 *
 * Archive side-channel:
 * - After every publish(), enqueues a BullMQ job to `stream-archive` queue
 *   (unless ARCHIVE_QUEUE_DISABLED=true). Audio events have their base64 payload
 *   stripped before enqueueing — only the event type and metadata are archived.
 *
 * @module lib/streams/stream-publisher
 */

import type Redis from 'ioredis';
import {
  StreamSessionKeys,
  StreamSessionConfig,
  type StreamEvent,
  type StreamEventType,
} from './types';

// ---------------------------------------------------------------------------
// Module-level singleton BullMQ Queue instances
// One Queue per (name, prefix) pair — shared across all publisher instances.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Queue: _BullQueue } = require('bullmq');
const _archiveQueues = new Map<string, InstanceType<typeof _BullQueue>>();

/**
 * Parse REDIS_URL into a BullMQ-compatible connection config object.
 * BullMQ needs { host, port, password } — not an ioredis instance.
 */
function parseBullMQConnectionFromEnv(): {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
  tls?: object;
} {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  try {
    const parsed = new URL(url);
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const db =
      parsed.pathname && parsed.pathname !== '/'
        ? parseInt(parsed.pathname.slice(1), 10)
        : 0;
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

function getArchiveQueue(
  name: string,
  _redis: unknown,
  prefix: string,
): InstanceType<typeof _BullQueue> {
  const key = `${prefix}:${name}`;
  if (!_archiveQueues.has(key)) {
    _archiveQueues.set(
      key,
      new _BullQueue(name, { connection: getBullMQConnection(), prefix }),
    );
  }
  return _archiveQueues.get(key)!;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export interface StreamSessionState {
  sessionId: string;
  streamId: string;
  provider: string;
  status: 'starting' | 'ready' | 'ended' | 'error';
  startedAt: number;
  endedAt?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StreamEventPublisherOptions {
  redis: Redis;
  sessionId: string;
  /** The parent stream config ID (for state labelling) */
  streamId?: string;
  /** The provider name (e.g. 'gemini-live') */
  provider?: string;
  /** TTL for the events replay list (default: 5 minutes) */
  eventsTtl?: number;
  /** TTL for the session state key (default: 1 hour) */
  stateTtl?: number;
  /** Owner user ID (for archive jobs) */
  userId?: string;
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

/**
 * StreamEventPublisher — publish stream session events to Redis.
 *
 * Usage:
 * ```typescript
 * const publisher = new StreamEventPublisher({ redis, sessionId, streamId, provider });
 * await publisher.sessionStart(streamId, provider);
 * await publisher.sessionReady();
 * // ... during session ...
 * await publisher.textOut('Hello from the model');
 * await publisher.toolCall('search', { query: 'hello' });
 * await publisher.toolResult('search', { results: [] });
 * await publisher.subgraphResult('search', { answer: '...' });
 * // on end
 * await publisher.sessionEnd('client_disconnect');
 * ```
 */
export class StreamEventPublisher {
  private readonly redis: Redis;
  private readonly sessionId: string;
  private readonly streamId: string;
  private readonly provider: string;
  private readonly channel: string;
  private readonly eventsKey: string;
  private readonly stateKey: string;
  private readonly eventsTtl: number;
  private readonly stateTtl: number;
  private readonly userId?: string;

  constructor(options: StreamEventPublisherOptions) {
    this.redis = options.redis;
    this.sessionId = options.sessionId;
    this.streamId = options.streamId ?? '';
    this.provider = options.provider ?? 'unknown';
    this.channel = StreamSessionKeys.channel(options.sessionId);
    this.eventsKey = StreamSessionKeys.events(options.sessionId);
    this.stateKey = StreamSessionKeys.state(options.sessionId);
    this.eventsTtl = options.eventsTtl ?? StreamSessionConfig.EVENTS_TTL_SECONDS;
    this.stateTtl = options.stateTtl ?? StreamSessionConfig.STATE_TTL_SECONDS;
    this.userId = options.userId;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Signal that a new session is starting and which provider is connecting. */
  async sessionStart(streamId: string, provider: string): Promise<void> {
    const state: StreamSessionState = {
      sessionId: this.sessionId,
      streamId,
      provider,
      status: 'starting',
      startedAt: Date.now(),
    };
    await this.saveState(state);
    await this.publish({
      type: 'session_start',
      sessionId: this.sessionId,
      streamId,
      provider,
      timestamp: Date.now(),
    });
  }

  /** Signal that the session is ready to receive input. */
  async sessionReady(): Promise<void> {
    await this.patchState({ status: 'ready' });
    await this.publish({
      type: 'session_ready',
      sessionId: this.sessionId,
      timestamp: Date.now(),
    });
  }

  /** Signal that the session has ended gracefully. */
  async sessionEnd(reason: string): Promise<void> {
    await this.patchState({ status: 'ended', endedAt: Date.now() });
    await this.publish({
      type: 'session_end',
      sessionId: this.sessionId,
      reason,
      timestamp: Date.now(),
    });
  }

  /** Signal that the session encountered a fatal error. */
  async sessionError(error: string): Promise<void> {
    await this.patchState({ status: 'error', error, endedAt: Date.now() });
    await this.publish({
      type: 'session_error',
      sessionId: this.sessionId,
      error,
      timestamp: Date.now(),
    });
  }

  // ── Audio / text ───────────────────────────────────────────────────────────

  /** Audio chunk arriving from the client toward the provider. */
  async audioIn(data: string): Promise<void> {
    await this.publish({
      type: 'audio_in',
      sessionId: this.sessionId,
      data,
      timestamp: Date.now(),
    });
  }

  /** Audio chunk arriving from the provider toward the client. */
  async audioOut(data: string): Promise<void> {
    await this.publish({
      type: 'audio_out',
      sessionId: this.sessionId,
      data,
      timestamp: Date.now(),
    });
  }

  /** Text input sent to the realtime provider. */
  async textIn(text: string): Promise<void> {
    await this.publish({
      type: 'text_in',
      sessionId: this.sessionId,
      text,
      timestamp: Date.now(),
    });
  }

  /** Text output received from the realtime provider. */
  async textOut(text: string): Promise<void> {
    await this.publish({
      type: 'text_out',
      sessionId: this.sessionId,
      text,
      timestamp: Date.now(),
    });
  }

  // ── Tool events ────────────────────────────────────────────────────────────

  /** Tool call issued by the realtime provider. */
  async toolCall(toolName: string, args: unknown): Promise<void> {
    await this.publish({
      type: 'tool_call',
      sessionId: this.sessionId,
      toolName,
      args,
      timestamp: Date.now(),
    });
  }

  /** Result returned from a synchronous tool invocation. */
  async toolResult(toolName: string, result: unknown): Promise<void> {
    await this.publish({
      type: 'tool_result',
      sessionId: this.sessionId,
      toolName,
      result,
      timestamp: Date.now(),
    });
  }

  // ── Async subgraph result ──────────────────────────────────────────────────

  /**
   * Publish the result of an async (fire-and-forget) subgraph execution.
   *
   * This method does two things:
   * 1. Publishes a `subgraph_result` event to the main stream channel
   *    (stream:channel:{sessionId}) for SSE observers.
   * 2. Publishes a plain JSON message to the result channel
   *    (stream:result:{sessionId}) for the session manager's result subscriber.
   *    The session manager decodes this and feeds the result back to the
   *    realtime provider as context text.
   */
  async subgraphResult(toolName: string, result: unknown): Promise<void> {
    // Publish to the main event stream (for SSE / archiver)
    await this.publish({
      type: 'subgraph_result',
      sessionId: this.sessionId,
      toolName,
      result,
      timestamp: Date.now(),
    });
    // Publish to the result channel — the session manager listens here
    const resultChannel = StreamSessionKeys.result(this.sessionId);
    await this.redis.publish(
      resultChannel,
      JSON.stringify({ toolName, result }),
    );
  }

  // ── State access ───────────────────────────────────────────────────────────

  /** Retrieve the current session state from Redis. */
  async getSessionState(): Promise<StreamSessionState | null> {
    try {
      const json = await this.redis.get(this.stateKey);
      if (!json) return null;
      return JSON.parse(json) as StreamSessionState;
    } catch {
      return null;
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private async publish(event: StreamEvent): Promise<void> {
    const json = JSON.stringify(event);
    // Publish to pub/sub for live listeners
    await this.redis.publish(this.channel, json);
    // Store in list for replay on reconnection (strip audio payloads to keep small)
    const archivable = stripAudio(event);
    const archiveJson = archivable === event ? json : JSON.stringify(archivable);
    await this.redis.rpush(this.eventsKey, archiveJson);
    await this.redis.expire(this.eventsKey, this.eventsTtl);
    // Fire-and-forget archive job
    this._enqueueArchive(event).catch(() => {});
  }

  private async saveState(state: StreamSessionState): Promise<void> {
    await this.redis.set(
      this.stateKey,
      JSON.stringify(state),
      'EX',
      this.stateTtl,
    );
  }

  private async patchState(patch: Partial<StreamSessionState>): Promise<void> {
    try {
      const existing = await this.getSessionState();
      if (!existing) return;
      await this.saveState({ ...existing, ...patch });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Enqueue a stream archive job.
   * No-op when ARCHIVE_QUEUE_DISABLED=true (local dev without the archiver).
   * Audio payloads are stripped — only type + metadata is archived.
   */
  private async _enqueueArchive(event: StreamEvent): Promise<void> {
    if (process.env.ARCHIVE_QUEUE_DISABLED === 'true') return;
    try {
      const seqKey = `archive:seq:stream:${this.sessionId}`;
      const seq = await this.redis.incr(seqKey);
      if (seq === 1) {
        await this.redis.expire(seqKey, this.eventsTtl);
      }
      const archiveEvent = stripAudio(event);
      const jobData = {
        type: 'stream',
        sessionId: this.sessionId,
        streamId: this.streamId,
        userId: this.userId,
        seq,
        event: archiveEvent,
        timestamp: Date.now(),
      };
      const prefix = process.env.BULLMQ_PREFIX ?? 'bull';
      const queue = getArchiveQueue('stream-archive', this.redis, prefix);
      await queue.add('archive', jobData, {
        jobId: `${this.sessionId}_${seq}`,
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 86400 },
      });
    } catch {
      // Silently swallow — archiving is a side-channel, never fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip base64 audio payload from audio events before writing to the replay
 * list and archive queue. Returns the original event unchanged for non-audio types.
 */
function stripAudio(event: StreamEvent): StreamEvent {
  if (event.type === 'audio_in' || event.type === 'audio_out') {
    const { data: _stripped, ...rest } = event;
    return { ...rest, data: '' } as StreamEvent;
  }
  return event;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStreamEventPublisher(
  options: StreamEventPublisherOptions,
): StreamEventPublisher {
  return new StreamEventPublisher(options);
}

// Re-export key types for convenience
export type { StreamEvent, StreamEventType };
