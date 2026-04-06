/**
 * RunPublisher
 *
 * Unified publisher for run state and events. Replaced the fragmented
 * legacy MessageQueue + GraphEventPublisher + McpEventPublisher system
 * (all three removed in v0.0.51-alpha).
 *
 * Key responsibilities:
 * - Maintain run state in Redis (run:{runId})
 * - Publish events to pub/sub channel (run:stream:{runId})
 * - Handle client ready signaling for streaming
 * - Provide state access and subscription methods
 *
 * Archive side-channel:
 * - After every publish(), enqueues a BullMQ job to `run-archive` queue
 *   (unless ARCHIVE_QUEUE_DISABLED=true). Each job has a dedup ID of
 *   `{runId}:{seq}` where seq is an atomic Redis INCR counter.
 *   Audio chunks are stripped of base64 payload before enqueueing.
 *
 * @module lib/run/run-publisher
 */
import type { Redis } from 'ioredis';
import { StreamPublisher, StreamSubscriber } from '@redbtn/redstream';
import {
  type RunState,
  type RunEvent,
  type RunOutput,
  type TokenMetadata,
  type ToolExecution,
  type AttachmentKind,
  RunKeys,
  RunConfig,
  createInitialRunState,
  createNodeProgress,
  createToolExecution,
} from './types';
import type { RedLog } from '@redbtn/redlog';
import { ConversationPublisher, createConversationPublisher } from '../conversation';

// Debug logging - set to true to enable verbose logs
const DEBUG = false;

// ---------------------------------------------------------------------------
// Module-level singleton BullMQ Queue instances
// One Queue per (name, prefix) pair — shared across all RunPublisher instances.
// Creating a Queue per event causes connection churn (C-1 fix).
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
    // Handle redis://:password@host:port format
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

/**
 * Options for RunPublisher constructor
 */
export interface RunPublisherOptions {
  /** Redis client instance */
  redis: Redis;
  /** Unique run identifier */
  runId: string;
  /** User executing the run */
  userId: string;
  /** TTL for run state in seconds (default: 1 hour) */
  stateTtl?: number;
  /** RedLog instance for structured logging */
  log?: RedLog;
}

/**
 * Subscription result
 */
export interface RunSubscription {
  /** Async generator yielding events */
  stream: AsyncGenerator<RunEvent, void, unknown>;
  /** Promise that resolves when subscription is ready */
  ready: Promise<void>;
  /** Cleanup function to unsubscribe */
  unsubscribe: () => Promise<void>;
}

/**
 * RunPublisher - Unified run state and event publisher
 */
export class RunPublisher {
  private readonly redis: Redis;
  private readonly runId: string;
  private readonly userId: string;
  private readonly stateTtl: number;
  private readonly redlog?: RedLog;
  private state: RunState | null = null;
  private initialized = false;
  /** ConversationPublisher for forwarding events to the chat UI */
  private convPublisher: ConversationPublisher | null = null;
  /** Message ID used for conversation stream (stable across run lifetime) */
  private convMessageId: string | null = null;

  constructor(options: RunPublisherOptions) {
    this.redis = options.redis;
    this.runId = options.runId;
    this.userId = options.userId;
    this.stateTtl = options.stateTtl ?? RunConfig.STATE_TTL_SECONDS;
    this.redlog = options.log;
  }

  get id(): string {
    return this.runId;
  }

  get user(): string {
    return this.userId;
  }

  // ===========================================================================
  // Persistent Logging Helper
  // ===========================================================================

  private async persistLog(params: {
    level: 'info' | 'warn' | 'error' | 'debug';
    category: string;
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const meta = {
      runId: this.runId,
      userId: this.userId,
      graphId: this.state?.graphId,
      graphName: this.state?.graphName,
      ...params.metadata,
    };
    if (!this.redlog) return;
    try {
      await this.redlog.log({
        level: params.level,
        message: params.message,
        category: params.category,
        scope: {
          conversationId: this.state?.conversationId,
          generationId: this.runId,
        },
        metadata: meta,
      });
    } catch (error) {
      if (DEBUG) console.error('[RunPublisher] redlog error:', error);
    }
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  async init(
    graphId: string,
    graphName: string,
    input: Record<string, unknown>,
    conversationId?: string,
    triggerType?: string,
  ): Promise<void> {
    if (this.initialized) {
      throw new Error(`RunPublisher already initialized for run ${this.runId}`);
    }
    // W-3: If the caller supplies triggerType explicitly (e.g. from enrichInput's
    // resolved trigger.type), inject it into the input snapshot stored in state so
    // that _enqueueArchive can always read it from this.state.input._trigger.type —
    // even when run() is called directly without going through enrichInput().
    let resolvedInput = input;
    if (triggerType && !(input as Record<string, any>)._trigger) {
      resolvedInput = { ...input, _trigger: { type: triggerType } };
    }
    this.state = createInitialRunState({
      runId: this.runId,
      userId: this.userId,
      graphId,
      graphName,
      input: resolvedInput,
      conversationId,
    });
    await this.saveState();
    if (conversationId) {
      await this.redis.set(RunKeys.conversationRun(conversationId), this.runId, 'EX', this.stateTtl);
      // Create ConversationPublisher for forwarding events to the chat UI
      try {
        this.convPublisher = createConversationPublisher({
          redis: this.redis,
          conversationId,
          userId: this.userId,
        });
        this.convMessageId = `msg_run_${this.runId}`;
        await this.convPublisher.publishRunStart(this.runId, this.convMessageId, graphId, graphName);
        if (DEBUG) console.log(`[RunPublisher] Conversation forwarding enabled for ${conversationId}`);
      } catch (err) {
        console.warn('[RunPublisher] Failed to create conversation publisher:', err);
        this.convPublisher = null;
      }
    }
    await this.publish({
      type: 'run_start',
      graphId,
      graphName,
      timestamp: Date.now(),
    });
    await this.persistLog({
      level: 'info',
      category: 'run',
      message: `Run started: ${graphName}`,
      metadata: { graphId, graphName, input },
    });
    this.initialized = true;
  }

  async complete(output?: Partial<RunOutput>): Promise<void> {
    this.ensureInitialized();
    if (output) {
      if (output.content !== undefined) this.state!.output.content = output.content;
      if (output.thinking !== undefined) this.state!.output.thinking = output.thinking;
      if (output.data !== undefined) this.state!.output.data = output.data;
    }
    this.state!.status = 'completed';
    this.state!.completedAt = Date.now();
    await this.saveState();
    if (this.state!.conversationId) {
      await this.redis.del(RunKeys.conversationRun(this.state!.conversationId));
    }
    // Forward to conversation stream
    if (this.convPublisher && this.convMessageId) {
      try {
        await this.convPublisher.publishRunComplete(
          this.runId,
          this.convMessageId,
          this.state!.output.content || undefined,
        );
      } catch (err) {
        if (DEBUG) console.warn('[RunPublisher] Conv forward run_complete failed:', err);
      }
    }
    await this.publish({
      type: 'run_complete',
      metadata: this.state!.metadata,
      timestamp: Date.now(),
    });
    const duration = this.state!.completedAt! - this.state!.startedAt;
    await this.persistLog({
      level: 'info',
      category: 'run',
      message: `Run completed: ${this.state!.graphName}`,
      metadata: {
        duration,
        nodesExecuted: this.state!.graph.nodesExecuted,
        tokenUsage: this.state!.metadata?.tokens?.total,
      },
    });
  }

  async fail(error: string): Promise<void> {
    this.ensureInitialized();
    this.state!.status = 'error';
    this.state!.error = error;
    this.state!.completedAt = Date.now();
    await this.saveState();
    if (this.state!.conversationId) {
      await this.redis.del(RunKeys.conversationRun(this.state!.conversationId));
    }
    // Forward to conversation stream
    if (this.convPublisher && this.convMessageId) {
      try {
        await this.convPublisher.publishRunError(this.runId, this.convMessageId, error);
      } catch (err) {
        if (DEBUG) console.warn('[RunPublisher] Conv forward run_error failed:', err);
      }
    }
    await this.publish({ type: 'run_error', error, timestamp: Date.now() });
    await this.persistLog({
      level: 'error',
      category: 'run',
      message: `Run failed: ${error}`,
      metadata: { error },
    });
  }

  // ===========================================================================
  // Status Updates
  // ===========================================================================

  async status(action: string, description?: string): Promise<void> {
    this.ensureInitialized();
    this.state!.currentStatus = { action, description };
    await this.saveState();
    await this.publish({ type: 'status', action, description, timestamp: Date.now() });
  }

  // ===========================================================================
  // Graph Events
  // ===========================================================================

  async graphStart(nodeCount: number, entryNodeId: string): Promise<void> {
    this.ensureInitialized();
    this.state!.status = 'running';
    this.state!.graph.entryNodeId = entryNodeId;
    await this.saveState();
    await this.publish({
      type: 'graph_start',
      runId: this.runId,
      graphId: this.state!.graphId,
      graphName: this.state!.graphName,
      nodeCount,
      entryNodeId,
      timestamp: Date.now(),
    });
  }

  async graphComplete(exitNodeId?: string, nodesExecuted?: number): Promise<void> {
    this.ensureInitialized();
    const duration = Date.now() - this.state!.startedAt;
    if (exitNodeId) this.state!.graph.exitNodeId = exitNodeId;
    if (nodesExecuted !== undefined) this.state!.graph.nodesExecuted = nodesExecuted;
    await this.saveState();
    await this.publish({
      type: 'graph_complete',
      exitNodeId,
      nodesExecuted: this.state!.graph.nodesExecuted,
      duration,
      timestamp: Date.now(),
    });
  }

  async graphError(error: string, failedNodeId?: string): Promise<void> {
    this.ensureInitialized();
    await this.publish({ type: 'graph_error', error, failedNodeId, timestamp: Date.now() });
  }

  // ===========================================================================
  // Node Events
  // ===========================================================================

  async nodeStart(nodeId: string, nodeType: string, nodeName: string): Promise<void> {
    this.ensureInitialized();
    const timestamp = Date.now();
    this.state!.graph.nodeProgress[nodeId] = createNodeProgress({ nodeName, nodeType });
    this.state!.graph.nodeProgress[nodeId].status = 'running';
    this.state!.graph.nodeProgress[nodeId].startedAt = timestamp;
    this.state!.graph.executionPath.push(nodeId);
    if (DEBUG) {
      try { console.log(`[RunPublisher] nodeStart run=${this.runId} node=${nodeId}`); } catch (_e) { /* ignore */ }
    }
    await this.saveState();
    await this.publish({ type: 'node_start', runId: this.runId, nodeId, nodeType, nodeName, timestamp });
    await this.persistLog({
      level: 'info',
      category: 'node',
      message: `Node started: ${nodeName}`,
      metadata: { nodeId, nodeType, nodeName },
    });
  }

  async nodeProgress(
    nodeId: string,
    step: string,
    options?: { index?: number; total?: number; data?: Record<string, unknown> },
  ): Promise<void> {
    this.ensureInitialized();
    const nodeProgress = this.state!.graph.nodeProgress[nodeId];
    if (nodeProgress) {
      nodeProgress.steps.push({ name: step, timestamp: Date.now(), data: options?.data });
    }
    await this.saveState();
    await this.publish({
      type: 'node_progress',
      nodeId,
      step,
      stepIndex: options?.index,
      totalSteps: options?.total,
      data: options?.data,
      timestamp: Date.now(),
    });
    const stepLabel =
      options?.index != null && options?.total != null
        ? `Step ${options.index + 1}/${options.total}: ${step}`
        : `Step: ${step}`;
    await this.persistLog({
      level: 'info',
      category: 'node',
      message: stepLabel,
      metadata: { nodeId, step, stepIndex: options?.index, totalSteps: options?.total, ...options?.data },
    });
  }

  async nodeComplete(nodeId: string, nextNodeId?: string, output?: Record<string, unknown>): Promise<void> {
    this.ensureInitialized();
    const nodeProgress = this.state!.graph.nodeProgress[nodeId];
    if (nodeProgress) {
      nodeProgress.status = 'completed';
      nodeProgress.completedAt = Date.now();
      nodeProgress.duration = nodeProgress.startedAt ? Date.now() - nodeProgress.startedAt : undefined;
    }
    if (DEBUG) {
      try {
        console.log(`[RunPublisher] nodeComplete run=${this.runId} node=${nodeId} duration_ms=${nodeProgress?.duration ?? 'n/a'}`);
      } catch (_e) { /* ignore */ }
    }
    this.state!.graph.nodesExecuted++;
    if (output) {
      this.state!.output.data = { ...this.state!.output.data, ...output };
    }
    await this.saveState();
    await this.publish({
      type: 'node_complete',
      nodeId,
      nextNodeId,
      duration: nodeProgress?.duration ?? 0,
      timestamp: Date.now(),
    });
    await this.persistLog({
      level: 'info',
      category: 'node',
      message: `Node completed: ${nodeProgress?.nodeName ?? nodeId}`,
      metadata: { nodeId, nodeType: nodeProgress?.nodeType, duration: nodeProgress?.duration, nextNodeId },
    });
  }

  async nodeError(nodeId: string, error: string): Promise<void> {
    this.ensureInitialized();
    const nodeProgress = this.state!.graph.nodeProgress[nodeId];
    if (nodeProgress) {
      nodeProgress.status = 'error';
      nodeProgress.error = error;
      nodeProgress.completedAt = Date.now();
    }
    await this.saveState();
    await this.publish({ type: 'node_error', nodeId, error, timestamp: Date.now() });
    await this.persistLog({
      level: 'error',
      category: 'node',
      message: `Node error: ${error}`,
      metadata: { nodeId, error },
    });
  }

  // ===========================================================================
  // Streaming
  // ===========================================================================

  async chunk(content: string): Promise<void> {
    this.ensureInitialized();
    this.state!.output.content += content;
    await this.publish({ type: 'chunk', content, timestamp: Date.now() });
    // Forward to conversation stream
    if (this.convPublisher && this.convMessageId) {
      this.convPublisher.streamContent(this.runId, this.convMessageId, content).catch((err) => {
        if (DEBUG) console.warn('[RunPublisher] Conv forward content_chunk failed:', err);
      });
    }
  }

  async thinkingChunk(content: string): Promise<void> {
    this.ensureInitialized();
    this.state!.output.thinking += content;
    await this.publish({ type: 'chunk', content, thinking: true, timestamp: Date.now() });
    // Forward to conversation stream
    if (this.convPublisher && this.convMessageId) {
      this.convPublisher.streamThinking(this.runId, this.convMessageId, content).catch((err) => {
        if (DEBUG) console.warn('[RunPublisher] Conv forward thinking_chunk failed:', err);
      });
    }
  }

  async thinkingComplete(): Promise<void> {
    this.ensureInitialized();
    await this.saveState();
    await this.publish({ type: 'thinking_complete', timestamp: Date.now() });
  }

  // ===========================================================================
  // Audio Streaming (Server-side TTS)
  // ===========================================================================

  async publishAudioChunk(audioBase64: string, index: number, isFinal: boolean): Promise<void> {
    this.ensureInitialized();
    await this.publish({
      type: 'audio_chunk' as any,
      audio: audioBase64,
      index,
      isFinal,
      format: 'mp3',
      timestamp: Date.now(),
    });
  }

  // ===========================================================================
  // Attachment Events
  // ===========================================================================

  /**
   * Publish an attachment event to the run stream and (if conversationId is set)
   * to the conversation stream so that the chat UI can render the file inline.
   *
   * Call this after the file has been stored (GridFS / external URL is known).
   * `fileId` and `url` are both optional — pass whichever is available.
   */
  async attachment(params: {
    attachmentId: string;
    kind: AttachmentKind;
    mimeType: string;
    filename: string;
    size: number;
    fileId?: string;
    url?: string;
    base64?: string;
    caption?: string;
  }): Promise<void> {
    this.ensureInitialized();
    const event = {
      type: 'attachment' as const,
      ...params,
      timestamp: Date.now(),
    };
    await this.publish(event);
    // Forward to conversation stream so the UI receives it without polling.
    // Pass convMessageId so the archiver can persist this attachment to the
    // correct in-flight message (W-4 fix).
    if (this.convPublisher) {
      this.convPublisher.publishAttachment(this.runId, event, this.convMessageId ?? undefined).catch((err) => {
        if (DEBUG) console.warn('[RunPublisher] Conv forward attachment failed:', err);
      });
    }
    await this.persistLog({
      level: 'info',
      category: 'attachment',
      message: `Attachment: ${params.filename} (${params.kind})`,
      metadata: {
        attachmentId: params.attachmentId,
        kind: params.kind,
        mimeType: params.mimeType,
        filename: params.filename,
        size: params.size,
        fileId: params.fileId,
        url: params.url,
      },
    });
  }

  // ===========================================================================
  // Tool Events
  // ===========================================================================

  async toolStart(
    toolId: string,
    toolName: string,
    toolType: string,
    options?: { input?: unknown },
  ): Promise<void> {
    this.ensureInitialized();
    const tool = createToolExecution({ toolId, toolName, toolType });
    this.state!.tools.push(tool);
    await this.saveState();
    const ts = Date.now();
    await this.publish({ type: 'tool_start', toolId, toolName, toolType, input: options?.input, timestamp: ts });
    // Forward to conversation stream
    if (this.convPublisher) {
      this.convPublisher.publishToolEvent(this.runId, {
        type: 'tool_start', toolId, toolName, toolType, input: options?.input, timestamp: ts,
      }).catch(() => {});
    }
    await this.persistLog({
      level: 'info',
      category: 'tool',
      message: `Tool started: ${toolName}`,
      metadata: { toolId, toolName, toolType, input: options?.input },
    });
  }

  async toolProgress(
    toolId: string,
    step: string,
    options?: { progress?: number; data?: Record<string, unknown> },
  ): Promise<void> {
    this.ensureInitialized();
    const tool = this.findTool(toolId);
    if (tool) {
      tool.steps.push({ name: step, timestamp: Date.now(), progress: options?.progress, data: options?.data });
    }
    await this.saveState();
    const ts = Date.now();
    await this.publish({ type: 'tool_progress', toolId, step, progress: options?.progress, data: options?.data, timestamp: ts });
    // Forward to conversation stream
    if (this.convPublisher) {
      this.convPublisher.publishToolEvent(this.runId, {
        type: 'tool_progress', toolId, toolName: tool?.toolName || '', toolType: tool?.toolType || '',
        step, progress: options?.progress, data: options?.data, timestamp: ts,
      }).catch(() => {});
    }
    await this.persistLog({
      level: 'info',
      category: 'tool',
      message: `Tool progress: ${step}`,
      metadata: { toolId, step, progress: options?.progress, ...options?.data },
    });
  }

  async toolComplete(toolId: string, result?: unknown, metadata?: Record<string, unknown>): Promise<void> {
    this.ensureInitialized();
    const tool = this.findTool(toolId);
    if (tool) {
      tool.status = 'completed';
      tool.completedAt = Date.now();
      tool.duration = Date.now() - tool.startedAt;
      tool.result = result;
    }
    await this.saveState();
    const ts = Date.now();
    await this.publish({ type: 'tool_complete', toolId, result, metadata, timestamp: ts });
    // Forward to conversation stream
    if (this.convPublisher) {
      this.convPublisher.publishToolEvent(this.runId, {
        type: 'tool_complete', toolId, toolName: tool?.toolName || '', toolType: tool?.toolType || '',
        result, metadata, timestamp: ts,
      }).catch(() => {});
    }
    // Extract a useful preview of the tool result for persistent logging.
    // For structured results (ssh_shell, invoke_function, etc.) we include
    // stdout/stderr/exitCode so command failures are diagnosable from logs.
    const resultPreview = summarizeToolResult(result);
    const logLevel = resultPreview.isFailure ? 'warn' : 'info';
    await this.persistLog({
      level: logLevel,
      category: 'tool',
      message: `Tool completed: ${tool?.toolName ?? toolId}${resultPreview.isFailure ? ' (non-zero exit)' : ''}`,
      metadata: { toolId, toolName: tool?.toolName, duration: tool?.duration, ...resultPreview.meta, ...metadata },
    });
  }

  async toolError(toolId: string, error: string): Promise<void> {
    this.ensureInitialized();
    const tool = this.findTool(toolId);
    if (tool) {
      tool.status = 'error';
      tool.completedAt = Date.now();
      tool.error = error;
    }
    await this.saveState();
    const ts = Date.now();
    await this.publish({ type: 'tool_error', toolId, error, timestamp: ts });
    // Forward to conversation stream
    if (this.convPublisher) {
      this.convPublisher.publishToolEvent(this.runId, {
        type: 'tool_error', toolId, toolName: tool?.toolName || '', toolType: tool?.toolType || '',
        error, timestamp: ts,
      }).catch(() => {});
    }
    await this.persistLog({
      level: 'error',
      category: 'tool',
      message: `Tool error: ${error}`,
      metadata: { toolId, toolName: tool?.toolName, error },
    });
  }

  // ===========================================================================
  // Metadata
  // ===========================================================================

  async setMetadata(metadata: TokenMetadata): Promise<void> {
    this.ensureInitialized();
    this.state!.metadata = { ...this.state!.metadata, ...metadata };
    await this.saveState();
  }

  // ===========================================================================
  // State Access
  // ===========================================================================

  async getState(): Promise<RunState | null> {
    const data = await this.redis.get(RunKeys.state(this.runId));
    if (!data) return null;
    return JSON.parse(data);
  }

  getCachedState(): RunState | null {
    return this.state;
  }

  // ===========================================================================
  // Subscription
  // ===========================================================================

  subscribe(): RunSubscription {
    const channel = RunKeys.stream(this.runId);
    const eventsKey = RunKeys.events(this.runId);
    const sub = new StreamSubscriber({ redis: this.redis, channel, eventsKey });
    const generator = sub.subscribe({
      catchUp: true,
      terminalEvents: ['run_complete', 'run_error'],
      idleTimeoutMs: 30000,
      isAlive: async () => {
        const state = await this.getState();
        return state !== null && state.status !== 'completed' && state.status !== 'error';
      },
    }) as AsyncGenerator<RunEvent, void, unknown>;
    const ready = Promise.resolve();
    const unsubscribe = async () => { await generator.return(undefined); };
    return { stream: generator, ready, unsubscribe };
  }

  async getInitEvent(): Promise<RunEvent | null> {
    const state = await this.getState();
    if (!state) return null;
    return { type: 'init', state, timestamp: Date.now() };
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private ensureInitialized(): void {
    if (!this.initialized || !this.state) {
      throw new Error(`RunPublisher not initialized. Call init() first for run ${this.runId}`);
    }
  }

  private async saveState(): Promise<void> {
    if (!this.state) return;
    await this.redis.set(RunKeys.state(this.runId), JSON.stringify(this.state), 'EX', this.stateTtl);
  }

  async publish(event: RunEvent): Promise<void> {
    const channel = RunKeys.stream(this.runId);
    const eventsKey = RunKeys.events(this.runId);
    const pub = new StreamPublisher({ redis: this.redis, channel, eventsKey, ttl: this.stateTtl });
    await pub.publish(event as any);
    // Fire-and-forget archive job — non-blocking, non-fatal
    this._enqueueArchive(event).catch(() => {});
  }

  /**
   * Enqueue an archive job for this run event.
   *
   * No-op when ARCHIVE_QUEUE_DISABLED=true (for local dev without the
   * webapp archiver running). Audio events have their base64 payload stripped
   * before enqueueing — only metadata is archived by default.
   */
  private async _enqueueArchive(event: RunEvent): Promise<void> {
    if (process.env.ARCHIVE_QUEUE_DISABLED === 'true') return;
    try {
      const seqKey = `archive:seq:run:${this.runId}`;
      const seq = await this.redis.incr(seqKey);
      // Expire the seq counter after the run state TTL so it doesn't accumulate
      if (seq === 1) {
        await this.redis.expire(seqKey, this.stateTtl);
      }
      // Strip base64 audio payload — archive metadata only by default
      let archiveEvent: Record<string, unknown> = event as unknown as Record<string, unknown>;
      if ((event as any).type === 'audio_chunk') {
        const { audio: _stripped, ...rest } = archiveEvent;
        archiveEvent = { ...rest, audioStripped: true };
      }
      // W-3: include triggerType so the archiver can correctly categorise the run.
      // _trigger is injected into the input by enrichInput() in the worker processor.
      const triggerType = (this.state?.input as Record<string, any>)?._trigger?.type as string | undefined;
      const jobData = {
        type: 'run',
        runId: this.runId,
        userId: this.userId,
        graphId: this.state?.graphId,
        conversationId: this.state?.conversationId,
        triggerType,
        seq,
        event: archiveEvent,
        timestamp: Date.now(),
      };
      // Use module-level singleton Queue to avoid per-event connection churn (C-1).
      const prefix = process.env.BULLMQ_PREFIX ?? 'bull';
      const queue = getArchiveQueue('run-archive', this.redis, prefix);
      await queue.add('archive', jobData, {
        jobId: `${this.runId}:${seq}`,
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 86400 },
      });
    } catch (err) {
      if (DEBUG) console.error('[RunPublisher] _enqueueArchive error:', err);
    }
  }

  async getEvents(): Promise<RunEvent[]> {
    const pub = new StreamPublisher({
      redis: this.redis,
      channel: RunKeys.stream(this.runId),
      eventsKey: RunKeys.events(this.runId),
      ttl: this.stateTtl,
    });
    return pub.getEvents() as Promise<RunEvent[]>;
  }

  async getEventsSince(startIndex: number): Promise<RunEvent[]> {
    const pub = new StreamPublisher({
      redis: this.redis,
      channel: RunKeys.stream(this.runId),
      eventsKey: RunKeys.events(this.runId),
      ttl: this.stateTtl,
    });
    return pub.getEventsSince(startIndex) as Promise<RunEvent[]>;
  }

  async getEventCount(): Promise<number> {
    const pub = new StreamPublisher({
      redis: this.redis,
      channel: RunKeys.stream(this.runId),
      eventsKey: RunKeys.events(this.runId),
      ttl: this.stateTtl,
    });
    return pub.getEventCount();
  }

  private findTool(toolId: string): ToolExecution | undefined {
    return this.state?.tools.find((t) => t.toolId === toolId);
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

export function createRunPublisher(options: RunPublisherOptions): RunPublisher {
  return new RunPublisher(options);
}

/**
 * Extract a useful, size-limited preview of a tool result for log metadata.
 * Understands MCP-style content arrays and common structured shapes
 * (ssh_shell, invoke_function) so command failures are diagnosable from logs.
 */
function summarizeToolResult(result: unknown): { meta: Record<string, unknown>; isFailure: boolean } {
  if (result == null) return { meta: {}, isFailure: false };
  const MAX_PREVIEW = 500;
  const trunc = (s: string) => (s.length > MAX_PREVIEW ? s.substring(0, MAX_PREVIEW) + '...[truncated]' : s);

  // Unwrap MCP content format: { content: [{ type:"text", text: "..." }] }
  let payload: any = result;
  if (payload && typeof payload === 'object' && Array.isArray((payload as any).content)) {
    const textBlock = (payload as any).content.find((b: any) => b?.type === 'text' && typeof b.text === 'string');
    if (textBlock) {
      try { payload = JSON.parse(textBlock.text); } catch { payload = textBlock.text; }
    }
  }

  // String result — just preview it
  if (typeof payload === 'string') {
    return { meta: { resultPreview: trunc(payload) }, isFailure: false };
  }

  if (typeof payload !== 'object') {
    return { meta: { result: payload }, isFailure: false };
  }

  const obj = payload as Record<string, any>;
  const meta: Record<string, unknown> = {};
  let isFailure = false;

  if ('exitCode' in obj) {
    meta.exitCode = obj.exitCode;
    if (typeof obj.exitCode === 'number' && obj.exitCode !== 0) isFailure = true;
  }
  if ('success' in obj && obj.success === false) isFailure = true;
  if ('error' in obj && obj.error) {
    meta.error = typeof obj.error === 'string' ? trunc(obj.error) : obj.error;
    isFailure = true;
  }
  if (typeof obj.stdout === 'string') meta.stdoutPreview = trunc(obj.stdout);
  if (typeof obj.stderr === 'string' && obj.stderr.length > 0) meta.stderrPreview = trunc(obj.stderr);
  if (typeof obj.durationMs === 'number') meta.toolDurationMs = obj.durationMs;
  if (typeof obj.status === 'number') meta.httpStatus = obj.status;

  // Nothing extracted → include a small JSON preview
  if (Object.keys(meta).length === 0) {
    try { meta.resultPreview = trunc(JSON.stringify(obj)); } catch { /* ignore */ }
  }
  return { meta, isFailure };
}

export async function getActiveRunForConversation(redis: Redis, conversationId: string): Promise<string | null> {
  const runId = await redis.get(RunKeys.conversationRun(conversationId));
  if (!runId) return null;
  const stateJson = await redis.get(RunKeys.state(runId));
  if (!stateJson) {
    await redis.del(RunKeys.conversationRun(conversationId));
    return null;
  }
  const state = JSON.parse(stateJson) as RunState;
  if (state.status === 'completed' || state.status === 'error') {
    await redis.del(RunKeys.conversationRun(conversationId));
    return null;
  }
  return runId;
}

export async function getRunState(redis: Redis, runId: string): Promise<RunState | null> {
  const stateJson = await redis.get(RunKeys.state(runId));
  if (!stateJson) return null;
  return JSON.parse(stateJson);
}

// =============================================================================
// Archive Queue Helper
// =============================================================================

/**
 * Queue names used by the stream archiver system.
 * Import this in the webapp to create the consumer workers on the same queues
 * that RunPublisher and ConversationPublisher enqueue into.
 */
export const ARCHIVE_QUEUE_NAMES = {
  RUN: 'run-archive',
  CONVERSATION: 'conversation-archive',
} as const;
