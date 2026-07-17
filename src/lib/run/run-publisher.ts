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
import {
  readSharedState,
  readSharedStateField,
  writeSharedState,
  deleteSharedState,
} from './run-shared-state';
import {
  readAutoState,
  writeAutoState,
  deleteAutoState,
} from './run-auto-state';
// Ownership-safe conversation-pointer cleanup. run:conversation:{id} stores the
// OWNING runId; a superseding run can repoint it at itself the moment this run's
// lock lapses, so every DEL of the pointer is a compare-and-delete against the
// owning runId (delete only while it still names us). Blind-deleting could wipe a
// fresh acquirer's live pointer — the exact TOCTOU class fixed in the orphan
// reaper (PR #276); this applies the same guard to the normal lifecycle paths.
import { releaseConversationPointerIfOwner } from './orphan-reaper';
import {
  touchRunProgress,
  type AutomationRunsCollection,
  type GenerationsCollection,
} from './progress-heartbeat';
import { StreamPublisher, StreamSubscriber } from '@redbtn/redstream';
import {
  type RunState,
  type RunEvent,
  type RunOutput,
  type TokenMetadata,
  type ToolExecution,
  type SubgraphTag,
  type AttachmentKind,
  RunKeys,
  RunConfig,
  createInitialRunState,
  createNodeProgress,
  createToolExecution,
} from './types';
import type { RedLog } from '@redbtn/redlog';
import { ConversationPublisher, createConversationPublisher } from '../conversation';
import { assertChatComponentSpec } from '../chat-components/spec-schema';
import { heartbeatAutomationSlot, releaseAutomationSlot } from './automation-concurrency';

// Debug logging - set to true to enable verbose logs
const DEBUG = false;

/**
 * Turn-by-turn output is how a conversation works — not a toggle. It is ALWAYS
 * on for every conversation run (any run with a ConversationPublisher); there is
 * deliberately no way to disable it. Single-turn graphs are unaffected because
 * they never change output kind, so they produce exactly one message anyway.
 */
function conversationSegmentationEnabled(): boolean {
  return true;
}

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
  /**
   * Optional agent/graph id used as the conversation participant in multi-agent
   * chats. When set, this value is stamped onto the persisted assistant message
   * as `metadata.agentId` so the chat UI can attribute the message to the
   * correct agent (name, avatar, colour) even after a page reload.
   */
  agentId?: string;
  /** Optional AutomationRun.runId to mirror progress heartbeat into Mongo. */
  automationRunId?: string;
  /** Optional automationruns collection handle for Mongo heartbeat mirroring. */
  automationRunsCollection?: AutomationRunsCollection;
  /** Optional generation id to mirror progress heartbeat into Mongo. Defaults to runId. */
  generationId?: string;
  /** Optional generations collection handle for Mongo heartbeat mirroring. */
  generationsCollection?: GenerationsCollection;
  /** TTL for run state in seconds (default: 1 hour) */
  stateTtl?: number;
  /** RedLog instance for structured logging */
  log?: RedLog;
  /**
   * Automation concurrency slot this run occupies. Set by the trigger path
   * (webhook receiver / cron scheduler) after it atomically claimed a slot via
   * `tryAcquireAutomationSlot`. When present, RunPublisher refreshes the slot's
   * heartbeat on every progress event and releases it on run terminal — so the
   * slot ages out on crash and frees promptly on clean completion. Omit for
   * non-automation runs (chat, subgraph).
   */
  concurrencySlot?: { automationId: string; triggerId?: string };
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
  /** Agent id for multi-agent attribution — stamped onto persisted messages. */
  private readonly agentId?: string;
  private readonly automationRunId?: string;
  private readonly automationRunsCollection?: AutomationRunsCollection;
  private readonly generationId: string;
  private readonly generationsCollection?: GenerationsCollection;
  private readonly stateTtl: number;
  private readonly redlog?: RedLog;
  /** Automation concurrency slot descriptor (automationId + triggerId). */
  private readonly concurrencySlot?: { automationId: string; triggerId?: string };
  /** Guards releaseConcurrencySlot so terminal-path double-calls stay a no-op. */
  private concurrencySlotReleased = false;
  /** Last time the concurrency slot heartbeat was refreshed (throttle guard). */
  private lastConcurrencyHeartbeatMs = 0;
  private state: RunState | null = null;
  private initialized = false;
  /** ConversationPublisher for forwarding events to the chat UI */
  private convPublisher: ConversationPublisher | null = null;
  /** Message ID for the CURRENT conversation segment (see segmentation below). */
  private convMessageId: string | null = null;

  // --- Turn-by-turn segmentation -------------------------------------------
  // ON by default for every conversation run (see conversationSegmentationEnabled).
  // A run emits MULTIPLE conversation messages — one per "turn" — instead of one
  // message that coalesces all thinking/tools/content. A new message (segment)
  // opens whenever the output KIND changes (thinking ↔ content ↔ tool), so the
  // conversation reads in true emission order: Working → tool → content →
  // tool → … . Single-turn graphs never change kind, so they still produce
  // exactly one message.
  private segmented = false;
  /** The first/base conv message id — segment ids derive from it deterministically. */
  private baseConvMessageId: string | null = null;
  private currentSegmentKind: 'thinking' | 'content' | 'tool' | null = null;
  private segmentIndex = 0;
  /**
   * toolId → the conversation segment (message id) the tool was STARTED in.
   * tool_complete / tool_error / tool_progress must target that same segment —
   * `convMessageId` may have advanced to a later content/thinking segment by the
   * time the tool finishes, which would otherwise leave the tool bubble stuck
   * "running" because the UI can't find it in the current segment.
   */
  private toolSegmentIds = new Map<string, string>();

  constructor(options: RunPublisherOptions) {
    this.redis = options.redis;
    this.runId = options.runId;
    this.userId = options.userId;
    this.agentId = options.agentId;
    this.automationRunId = options.automationRunId;
    this.automationRunsCollection = options.automationRunsCollection;
    this.generationId = options.generationId ?? options.runId;
    this.generationsCollection = options.generationsCollection;
    this.stateTtl = options.stateTtl ?? RunConfig.STATE_TTL_SECONDS;
    this.redlog = options.log;
    this.concurrencySlot = options.concurrencySlot;
  }

  /**
   * Refresh the automation concurrency slot heartbeat. Best-effort — a
   * concurrency-store hiccup must never fail the run. No-op when this run does
   * not occupy a slot (chat / subgraph) or the slot was already released.
   */
  private async heartbeatConcurrencySlot(): Promise<void> {
    if (!this.concurrencySlot || this.concurrencySlotReleased) return;
    // Throttle: the stale window is 30 min, so refreshing every ~15s keeps the
    // slot comfortably alive without hammering Redis on every streamed chunk.
    const now = Date.now();
    if (now - this.lastConcurrencyHeartbeatMs < RunConfig.AUTOMATION_RUN_HEARTBEAT_THROTTLE_MS) return;
    this.lastConcurrencyHeartbeatMs = now;
    try {
      await heartbeatAutomationSlot(this.redis, {
        automationId: this.concurrencySlot.automationId,
        triggerId: this.concurrencySlot.triggerId,
        runId: this.runId,
      });
    } catch (err) {
      console.warn(`[RunPublisher] concurrency heartbeat failed for ${this.runId}:`, err);
    }
  }

  /**
   * Release the automation concurrency slot. Best-effort + idempotent — called
   * from every terminal path (complete / fail / interrupt). The stale-window
   * prune is the real backstop if this never lands (crash), but releasing on
   * clean terminal frees the slot immediately.
   */
  private async releaseConcurrencySlot(): Promise<void> {
    if (!this.concurrencySlot || this.concurrencySlotReleased) return;
    this.concurrencySlotReleased = true;
    try {
      await releaseAutomationSlot(this.redis, {
        automationId: this.concurrencySlot.automationId,
        triggerId: this.concurrencySlot.triggerId,
        runId: this.runId,
      });
    } catch (err) {
      console.warn(`[RunPublisher] concurrency release failed for ${this.runId}:`, err);
    }
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
    /**
     * Externally-minted message id for the assistant message this run will
     * produce. When supplied, the conversation publisher uses this id on every
     * event (run_start / chunks / run_complete) instead of generating its own.
     * Allows dispatch endpoints to pre-allocate the messageId and return it to
     * the client in the same response that submits the run — so optimistic UI
     * can pre-create the assistant bubble with the matching id before any SSE
     * event arrives.
     */
    convMessageId?: string,
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
        // Unified message id format for both graph runs and streams:
        // `msg_<ts>_<rand>`. Honour an externally-provided id (dispatch
        // pre-allocates one so the response and SSE events agree) and only
        // mint a fresh one when the caller didn't supply.
        this.convMessageId = convMessageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.baseConvMessageId = this.convMessageId;
        this.segmented = conversationSegmentationEnabled();
        await this.convPublisher.publishRunStart(this.runId, this.convMessageId, graphId, graphName);
        // Presence: "this run is working", decoupled from any message. The chat
        // UI shows the Working/Reconnecting indicator from this — no empty
        // pre-allocated bubble needed. Ephemeral; reload restores via the
        // /active-generation probe.
        await this.convPublisher.publishPresence(this.runId, 'working', {
          messageId: this.convMessageId,
          ...(this.agentId ? { agentId: this.agentId } : {}),
        });
        if (DEBUG) console.log(`[RunPublisher] Conversation forwarding enabled for ${conversationId}${this.segmented ? ' (segmented turn-by-turn)' : ''}`);
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

  /**
   * Read the entire shared-state hash for this run. Returns `{}` when
   * no branch has written anything yet. Cheap — single HGETALL.
   *
   * `state.shared` in graph configs is hydrated from this on every
   * step boundary (see UniversalNode + LoopExecutor) so polling-style
   * patterns naturally see writes from peer parallel branches.
   */
  async getSharedState(): Promise<Record<string, unknown>> {
    return readSharedState(this.redis, this.runId);
  }

  /**
   * Read a single shared-state field. Returns `undefined` when missing.
   */
  async getSharedField(key: string): Promise<unknown> {
    return readSharedStateField(this.redis, this.runId, key);
  }

  /**
   * Set a single shared-state field. Refreshes the hash's TTL on every
   * write so an active run keeps its shared state alive. Routes here
   * from transform `set` operations whose `outputField` starts with
   * `shared.<key>` — see TransformExecutor.
   */
  async setSharedField(key: string, value: unknown): Promise<void> {
    await writeSharedState(this.redis, this.runId, key, value);
  }

  /**
   * Read the entire auto-state hash for this run. Each entry's key
   * is a full state path (e.g. `data.thinking`). UniversalNode +
   * LoopExecutor call this before each step / iteration when the
   * current node is in parallel context, then overlay the result
   * onto local state via `applyAutoStateOnto`.
   */
  async getAutoState(): Promise<Record<string, unknown>> {
    return readAutoState(this.redis, this.runId);
  }

  /**
   * Write a single (path, value) into the auto-state hash. Routes
   * here from transformExecutor when a step in a parallel-context
   * node has an `outputField` — the engine dual-writes to local
   * state and here, so peer branches see the update at their next
   * step boundary.
   */
  async setAutoStateField(path: string, value: unknown): Promise<void> {
    await writeAutoState(this.redis, this.runId, path, value);
  }

  /**
   * Mark the run as completed and publish the `run_complete` event.
   *
   * @param output - Optional convenience fields (content/thinking/data) captured
   *   by the caller. These are merged into `RunState.output` so they appear in
   *   `getRunState()` results.
   * @param finalState - Optional FULL final graph state object (the return value
   *   of `graph.invoke()` or equivalent). When provided, the published
   *   `run_complete` event's `output` carries this entire object verbatim, so
   *   downstream consumers can read any state field the graph wrote — not just
   *   the LLM-shaped `content`/`thinking`/`data`/`response` quadrant.
   *
   *   Canonical aliases (`content`, `thinking`, `data`, `response`) are always
   *   layered on top of the emitted `output` so existing consumers keep working
   *   even when `finalState` is not supplied.
   */
  async complete(
    output?: Partial<RunOutput>,
    finalState?: Record<string, unknown>,
  ): Promise<void> {
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
      // Compare-and-delete: only clear the pointer while it still names THIS run,
      // so a run that already superseded us in this conversation keeps its pointer.
      await releaseConversationPointerIfOwner(this.redis, this.state!.conversationId, this.runId);
    }
    // Drop the shared-state hash now that no parallel branches will
    // run again. TTL would clean it up eventually, but explicit del
    // keeps Redis tidy and reclaims the space immediately.
    await deleteSharedState(this.redis, this.runId);
    await deleteAutoState(this.redis, this.runId);
    // Free this run's automation concurrency slot immediately (best-effort;
    // the stale-window prune is the backstop if the process dies first).
    await this.releaseConcurrencySlot();
    // Presence: run done → clear the Working indicator.
    if (this.convPublisher) {
      await this.convPublisher.publishPresence(this.runId, 'idle', {
        ...(this.agentId ? { agentId: this.agentId } : {}),
      }).catch(() => {});
    }
    // Forward to conversation stream
    if (this.convPublisher && this.convMessageId) {
      try {
        await this.convPublisher.publishRunComplete(
          this.runId,
          this.convMessageId,
          this.state!.output.content || undefined,
          // Pass the run's tool history for the persistence backstop. The
          // archiver builds tool data from tool_event forwards; when those
          // lapse silently the persisted assistant message has empty tools.
          // This array goes into the message via persistMessage's in-place
          // $set so the truth lands even when forwarding doesn't.
          this.state!.tools,
          // Pass the completed graph run trace so the chat UI can render the
          // finished graph run. Node-progress events aren't forwarded over the
          // conversation stream, so this server-side persistence is the only
          // source of real executionPath/nodeProgress on the message.
          {
            graphId: this.state!.graphId,
            runId: this.runId,
            status: 'completed',
            executionPath: this.state!.graph.executionPath || [],
            nodeProgress: this.state!.graph.nodeProgress || {},
          },
          // Thread agentId through so it lands on metadata.agentId of the
          // persisted message. Absent for single-agent / non-attributed runs.
          this.agentId,
        );
      } catch (err) {
        console.warn("[RunPublisher] Conv forward run_complete failed:", err);
      }
    }

    // Build the run_complete event `output`:
    //   1. Start from the FULL final graph state (so any state-root field —
    //      `systemPrompt`, `setupOutput`, custom graph fields — is preserved).
    //   2. Layer canonical aliases (content/thinking/data/response) on top so
    //      consumers reading `output.response` or `output.content` keep working
    //      regardless of the underlying graph shape.
    //
    // If no finalState was supplied, the event still carries the legacy
    // RunOutput quadrant via the aliases — behaviour is backwards-compatible.
    const runOutput = this.state!.output;

    // Derive a canonical `response` alias: prefer state.data.response,
    // then state.response (when finalState is supplied), then content.
    const dataResponse =
      runOutput?.data && typeof runOutput.data === 'object'
        ? (runOutput.data as Record<string, unknown>).response
        : undefined;
    const rootResponse =
      finalState && typeof finalState === 'object'
        ? (finalState as Record<string, unknown>).response
        : undefined;
    const responseValue =
      dataResponse !== undefined
        ? dataResponse
        : rootResponse !== undefined
        ? rootResponse
        : runOutput?.content
        ? runOutput.content
        : undefined;

    // Spread the full state first, then overwrite with canonical aliases.
    // Guard against accidental circular-ref fields (neuronRegistry, memory, etc.)
    // that the engine passes into initial state — strip well-known non-serialisable
    // keys so JSON.stringify in StreamPublisher doesn't blow up.
    const safeFinalState =
      finalState && typeof finalState === 'object'
        ? stripNonSerialisableStateFields(finalState)
        : {};

    const eventOutput: Record<string, unknown> = {
      ...safeFinalState,
      content: runOutput?.content ?? '',
      thinking: runOutput?.thinking ?? '',
      data: runOutput?.data ?? {},
      response: responseValue,
    };

    // Terminal-binding exit code: a graph node can force a non-zero exit by
    // writing `state.exitCode` (read from the full final state, then the legacy
    // `state.data.exitCode` fallback). Absent / non-numeric → 0 (success).
    const rawExit =
      (safeFinalState as Record<string, unknown>).exitCode ??
      (runOutput?.data && typeof runOutput.data === 'object'
        ? (runOutput.data as Record<string, unknown>).exitCode
        : undefined);
    const exitCode = typeof rawExit === 'number' && Number.isFinite(rawExit) ? rawExit : 0;

    await this.publish({
      type: 'run_complete',
      metadata: this.state!.metadata,
      output: eventOutput,
      exitCode,
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

  /**
   * Mark the run as failed and publish the terminal `run_error` event.
   *
   * Symmetric with `complete()` — callers should ALWAYS be able to rely on
   * a terminal event landing on the run stream channel so that subscribers
   * (`dispatchToolCall`, `runStartupGraph`, `_subscribeAndRouteOutput`) can
   * early-reject instead of hanging until their 60s timeout.
   *
   * Emits BOTH `run_error` (canonical) and `run_failed` (alias) so consumers
   * that listen for either name keep working.
   *
   * @param error - Human-readable error message (required)
   * @param errorStack - Optional error stack trace for debugging
   */
  async fail(error: string, errorStack?: string): Promise<void> {
    this.ensureInitialized();
    this.state!.status = 'error';
    this.state!.error = error;
    this.state!.completedAt = Date.now();
    await this.saveState();
    if (this.state!.conversationId) {
      // Compare-and-delete: spare a superseding run's pointer (see complete()).
      await releaseConversationPointerIfOwner(this.redis, this.state!.conversationId, this.runId);
    }
    await deleteSharedState(this.redis, this.runId);
    await deleteAutoState(this.redis, this.runId);
    // Free this run's automation concurrency slot immediately (best-effort;
    // the stale-window prune is the backstop if the process dies first).
    await this.releaseConcurrencySlot();
    // Presence: run errored → clear the Working indicator.
    if (this.convPublisher) {
      await this.convPublisher.publishPresence(this.runId, 'idle', {
        ...(this.agentId ? { agentId: this.agentId } : {}),
      }).catch(() => {});
    }
    // Forward to conversation stream
    if (this.convPublisher && this.convMessageId) {
      try {
        // Pass tools so the assistant message gets the tool history that
        // ran before the failure. Same backstop semantics as complete().
        await this.convPublisher.publishRunError(
          this.runId,
          this.convMessageId,
          error,
          this.state!.tools,
          // Thread agentId so failed-run messages are also attributed.
          this.agentId,
        );
      } catch (err) {
        console.warn("[RunPublisher] Conv forward run_error failed:", err);
      }
    }
    // Cap stack trace size to keep pub/sub + archive-queue payloads small.
    const truncatedStack =
      errorStack && errorStack.length > 4000
        ? errorStack.slice(0, 4000) + '\n...[truncated]'
        : errorStack;
    const ts = Date.now();
    // Canonical terminal event
    await this.publish({
      type: 'run_error',
      error,
      errorStack: truncatedStack,
      runId: this.runId,
      exitCode: 1,
      timestamp: ts,
    });
    // Alias event — publish both so any consumer listening for either name
    // resolves its wait. Webapp's dispatchToolCall already listens for both;
    // this future-proofs other consumers (e.g., logs page, chat UI).
    await this.publish({
      type: 'run_failed',
      error,
      errorStack: truncatedStack,
      runId: this.runId,
      exitCode: 1,
      timestamp: ts,
    });
    await this.persistLog({
      level: 'error',
      category: 'run',
      message: `Run failed: ${error}`,
      metadata: { error, errorStack: truncatedStack },
    });
  }

  /**
   * Mark the run as interrupted by an external actor and publish the terminal
   * `run_interrupted` event.
   *
   * Symmetric with `complete()` and `fail()` — emitted when the engine's
   * `AbortController` for this run trips because someone published to the
   * `run:interrupt:{runId}` channel.
   *
   * State at the last completed graph node has already been written to
   * MongoCheckpointer (graphcheckpoints collection, 7-day TTL); a new run can
   * resume from it by passing `resumeFromRunId: <prevRunId>` in RunOptions.
   * The replay materialises prior channel values onto `state.previousRun` so
   * graph nodes can read them via `{{state.previousRun.someField}}` templates.
   *
   * @param reason - Optional free-form reason supplied by the interrupter
   */
  async interrupt(reason?: string): Promise<void> {
    this.ensureInitialized();
    this.state!.status = 'interrupted';
    this.state!.completedAt = Date.now();
    if (reason) this.state!.error = `interrupted: ${reason}`;
    await this.saveState();
    if (this.state!.conversationId) {
      // Compare-and-delete: spare a superseding run's pointer (see complete()).
      // Critical on the interrupt path — interrupts are how one run supersedes
      // another, so a fresh acquirer racing this cleanup is the common case.
      await releaseConversationPointerIfOwner(this.redis, this.state!.conversationId, this.runId);
    }
    await deleteSharedState(this.redis, this.runId);
    await deleteAutoState(this.redis, this.runId);
    // Free this run's automation concurrency slot immediately (best-effort;
    // the stale-window prune is the backstop if the process dies first).
    await this.releaseConcurrencySlot();
    // Presence: run interrupted → clear the Working indicator.
    if (this.convPublisher) {
      await this.convPublisher.publishPresence(this.runId, 'idle', {
        ...(this.agentId ? { agentId: this.agentId } : {}),
      }).catch(() => {});
    }
    // Forward to conversation stream if present so chat UI can render the
    // interrupt indicator and stop showing the spinner.
    if (this.convPublisher && this.convMessageId) {
      try {
        // Pass tools so the assistant message gets the tool history that
        // ran before the interrupt. Same backstop semantics as complete().
        await this.convPublisher.publishRunError(
          this.runId,
          this.convMessageId,
          reason ? `Run interrupted: ${reason}` : 'Run interrupted',
          this.state!.tools,
          // Thread agentId so interrupted-run messages are also attributed.
          this.agentId,
        );
      } catch (err) {
        console.warn("[RunPublisher] Conv forward run_interrupted failed:", err);
      }
    }
    const ts = Date.now();
    await this.publish({
      type: 'run_interrupted',
      runId: this.runId,
      reason,
      exitCode: 130,
      timestamp: ts,
    });
    await this.persistLog({
      level: 'info',
      category: 'run',
      message: `Run interrupted${reason ? `: ${reason}` : ''}`,
      metadata: { reason },
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
  // Terminal Output (Terminal binding)
  // ===========================================================================

  /**
   * Publish an explicit stdout chunk. Used by the Terminal binding (and any
   * command-style graph node) that wants shell-accurate output framing rather
   * than relying on the binding's `chunk → stdout` mapping. Fire-and-forget
   * from the engine's perspective; subscribers map it straight to stdout.
   */
  async stdout(chunk: string): Promise<void> {
    this.ensureInitialized();
    await this.publish({ type: 'stdout', chunk, timestamp: Date.now() });
  }

  /**
   * Publish an explicit stderr chunk. Symmetric with `stdout()`; subscribers
   * map it straight to stderr (and the binding treats it as a soft error
   * signal that does NOT by itself set a non-zero exit code).
   */
  async stderr(chunk: string): Promise<void> {
    this.ensureInitialized();
    await this.publish({ type: 'stderr', chunk, timestamp: Date.now() });
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

  /**
   * Turn-by-turn boundary. When segmentation is on, opening a different KIND of
   * output (thinking ↔ content ↔ tool) closes the current conversation message
   * and opens a fresh one, so each turn is its own bubble in emission order.
   * The first segment reuses the run's pre-allocated message (from
   * publishRunStart) so the optimistic bubble still collapses. Segment ids are
   * derived deterministically from the base id (`<base>-s<N>`) so a worker
   * retry reproduces the same ids and the archiver upserts idempotently.
   * No-op when segmentation is off or the kind hasn't changed (so it costs
   * nothing per-token — boundaries fire once per turn, not per chunk).
   */
  private async ensureSegment(kind: 'thinking' | 'content' | 'tool'): Promise<void> {
    if (!this.segmented || !this.convPublisher || !this.convMessageId) return;
    if (this.currentSegmentKind === kind) return;
    if (this.currentSegmentKind === null) {
      // First segment: emit a real message_start for the base id (segment 0).
      // run_start no longer creates the assistant message (it's now presence-
      // only in the decoupled UI), so the first turn must mint its own message.
      // Same base id → the optimistic-bubble mapping and idempotent upsert hold.
      this.currentSegmentKind = kind;
      await this.convPublisher.startMessage(this.convMessageId, 'assistant', {
        runId: this.runId,
        segmentIndex: 0,
        kind,
        ...(this.agentId ? { agentId: this.agentId } : {}),
      }).catch(() => {});
      return;
    }
    // Kind changed → close the open segment, open a new one.
    const prevId = this.convMessageId;
    await this.convPublisher.completeMessage(prevId).catch(() => {});
    this.segmentIndex += 1;
    const newId = `${this.baseConvMessageId}-s${this.segmentIndex}`;
    this.convMessageId = newId;
    this.currentSegmentKind = kind;
    await this.convPublisher.startMessage(newId, 'assistant', {
      runId: this.runId,
      segmentIndex: this.segmentIndex,
      kind,
      ...(this.agentId ? { agentId: this.agentId } : {}),
    }).catch(() => {});
  }

  async chunk(content: string): Promise<void> {
    this.ensureInitialized();
    this.state!.output.content += content;
    await this.publish({ type: 'chunk', content, timestamp: Date.now() });
    // Forward to conversation stream
    if (this.convPublisher && this.convMessageId) {
      // Only open/switch a content segment on real (non-whitespace) content so
      // we never mint empty "No response" bubbles. Whitespace that arrives while
      // a content segment is already open still streams through (preserves the
      // spaces between word chunks); whitespace at a kind boundary is dropped as
      // leading trim rather than opening an empty segment.
      if (content.trim().length > 0) await this.ensureSegment('content');
      if (this.currentSegmentKind === 'content') {
        this.convPublisher.streamContent(this.runId, this.convMessageId, content).catch((err) => {
          console.warn("[RunPublisher] Conv forward content_chunk failed:", err);
        });
      }
    }
  }

  async thinkingChunk(content: string): Promise<void> {
    this.ensureInitialized();
    this.state!.output.thinking += content;
    await this.publish({ type: 'chunk', content, thinking: true, timestamp: Date.now() });
    // Forward to conversation stream
    if (this.convPublisher && this.convMessageId) {
      // Same guard as content: only open/switch a thinking segment on real
      // (non-whitespace) reasoning text so empty reasoning never mints a bubble.
      if (content.trim().length > 0) await this.ensureSegment('thinking');
      if (this.currentSegmentKind === 'thinking') {
        this.convPublisher.streamThinking(this.runId, this.convMessageId, content).catch((err) => {
          console.warn("[RunPublisher] Conv forward thinking_chunk failed:", err);
        });
      }
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
        console.warn("[RunPublisher] Conv forward attachment failed:", err);
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
  // Component Events (chat-interactive-widgets, phase 2)
  // ===========================================================================

  /**
   * Publish a chat-component event to the run stream and (if conversationId is
   * set) to the conversation stream so the chat UI can render it inline.
   *
   * The input is the *spec body* without engine-injected provenance — this
   * method injects `runId`, `messageId`, `emittedAt`, and `surfaces: ['chat']`,
   * then re-validates the assembled spec against the frozen v1 JSON Schema
   * (`lib/chat-components/spec-schema.ts`). If validation fails, throws
   * `ChatComponentSpecValidationError` and emits nothing — the publisher
   * never carries an invalid spec onto the stream.
   *
   * @throws {ChatComponentSpecValidationError} if the assembled spec is invalid.
   */
  async publishComponent(spec: Record<string, unknown>): Promise<void> {
    this.ensureInitialized();

    const messageId = this.convMessageId ?? undefined;
    const emittedAt = new Date().toISOString();
    const assembled: Record<string, unknown> = {
      ...spec,
      runId: this.runId,
      ...(messageId ? { messageId } : {}),
      surfaces: ['chat'],
      emittedAt,
    };
    const validated = assertChatComponentSpec(assembled);

    const event = {
      type: 'component' as const,
      componentId: validated.componentId,
      runId: this.runId,
      ...(messageId ? { messageId } : {}),
      spec: validated as unknown as Record<string, unknown>,
      timestamp: Date.now(),
    };
    await this.publish(event);

    if (this.convPublisher) {
      this.convPublisher.publishComponent(this.runId, event, messageId).catch((err) => {
        console.warn('[RunPublisher] Conv forward component failed:', err);
      });
    }

    await this.persistLog({
      level: 'info',
      category: 'component',
      message: `Component emitted: ${validated.type} (${validated.componentId})`,
      metadata: {
        componentId: validated.componentId,
        type: validated.type,
        messageId,
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
    options?: {
      input?: unknown;
      /** Source of this tool call. Defaults to `'step'` for backward compat. */
      triggeredBy?: 'step' | 'neuron';
      /** Owning neuron step id when triggeredBy === 'neuron'. */
      neuronStepId?: string;
      /**
       * Subgraph origin tag — present only when this tool ran inside a
       * subgraph (a universal-node `graph` step). Top-level tools omit it.
       * Tags the persisted `state.tools` entry, the tool_start event, and the
       * tool log metadata so the UI can hide/show subgraph-originated tools.
       */
      subgraph?: SubgraphTag;
    },
  ): Promise<void> {
    this.ensureInitialized();
    const subgraph = options?.subgraph;
    const tool = createToolExecution({ toolId, toolName, toolType, subgraph });
    this.state!.tools.push(tool);
    await this.saveState();
    const ts = Date.now();
    const triggeredBy = options?.triggeredBy ?? 'step';
    const neuronStepId = options?.neuronStepId;
    await this.publish({
      type: 'tool_start',
      toolId,
      toolName,
      toolType,
      input: options?.input,
      triggeredBy,
      neuronStepId,
      ...(subgraph ? { subgraph } : {}),
      timestamp: ts,
    });
    // Forward to conversation stream
    if (this.convPublisher) {
      // A tool call is its own turn: open a `tool` segment so it renders as a
      // distinct bubble between text turns (no-op when segmentation is off).
      await this.ensureSegment('tool');
      // Remember which segment this tool lives in so its later complete/error
      // events target the SAME bubble even after the segment advances.
      if (this.convMessageId) this.toolSegmentIds.set(toolId, this.convMessageId);
      this.convPublisher.publishToolEvent(this.runId, this.convMessageId ?? "", {
        type: 'tool_start', toolId, toolName, toolType, input: options?.input,
        triggeredBy, neuronStepId, ...(subgraph ? { subgraph } : {}), timestamp: ts,
      }).catch(() => {});
    }
    await this.persistLog({
      level: 'info',
      category: 'tool',
      message: `Tool started: ${toolName}`,
      metadata: {
        toolId, toolName, toolType, input: options?.input, triggeredBy, neuronStepId,
        ...(subgraph ? { subgraph } : {}),
      },
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
    const subgraph = tool?.subgraph;
    await this.publish({ type: 'tool_progress', toolId, step, progress: options?.progress, data: options?.data, ...(subgraph ? { subgraph } : {}), timestamp: ts });
    // Forward to conversation stream
    if (this.convPublisher) {
      this.convPublisher.publishToolEvent(this.runId, this.toolSegmentIds.get(toolId) ?? this.convMessageId ?? "", {
        type: 'tool_progress', toolId, toolName: tool?.toolName || '', toolType: tool?.toolType || '',
        step, progress: options?.progress, data: options?.data, ...(subgraph ? { subgraph } : {}), timestamp: ts,
      }).catch(() => {});
    }
    await this.persistLog({
      level: 'info',
      category: 'tool',
      message: `Tool progress: ${step}`,
      metadata: { toolId, step, progress: options?.progress, ...options?.data, ...(subgraph ? { subgraph } : {}) },
    });
  }

  async toolComplete(
    toolId: string,
    result?: unknown,
    metadata?: Record<string, unknown>,
    options?: { triggeredBy?: 'step' | 'neuron'; neuronStepId?: string },
  ): Promise<void> {
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
    const triggeredBy = options?.triggeredBy ?? 'step';
    const neuronStepId = options?.neuronStepId;
    const subgraph = tool?.subgraph;
    await this.publish({
      type: 'tool_complete', toolId, result, metadata,
      triggeredBy, neuronStepId, ...(subgraph ? { subgraph } : {}), timestamp: ts,
    });
    // Forward to conversation stream
    if (this.convPublisher) {
      this.convPublisher.publishToolEvent(this.runId, this.toolSegmentIds.get(toolId) ?? this.convMessageId ?? "", {
        type: 'tool_complete', toolId, toolName: tool?.toolName || '', toolType: tool?.toolType || '',
        result, metadata, triggeredBy, neuronStepId, ...(subgraph ? { subgraph } : {}), timestamp: ts,
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
      metadata: { toolId, toolName: tool?.toolName, duration: tool?.duration, ...resultPreview.meta, ...metadata, ...(subgraph ? { subgraph } : {}) },
    });
  }

  async toolError(
    toolId: string,
    error: string,
    options?: { triggeredBy?: 'step' | 'neuron'; neuronStepId?: string },
  ): Promise<void> {
    this.ensureInitialized();
    const tool = this.findTool(toolId);
    if (tool) {
      tool.status = 'error';
      tool.completedAt = Date.now();
      tool.error = error;
    }
    await this.saveState();
    const ts = Date.now();
    const triggeredBy = options?.triggeredBy ?? 'step';
    const neuronStepId = options?.neuronStepId;
    const subgraph = tool?.subgraph;
    await this.publish({
      type: 'tool_error', toolId, error,
      triggeredBy, neuronStepId, ...(subgraph ? { subgraph } : {}), timestamp: ts,
    });
    // Forward to conversation stream
    if (this.convPublisher) {
      this.convPublisher.publishToolEvent(this.runId, this.toolSegmentIds.get(toolId) ?? this.convMessageId ?? "", {
        type: 'tool_error', toolId, toolName: tool?.toolName || '', toolType: tool?.toolType || '',
        error, triggeredBy, neuronStepId, ...(subgraph ? { subgraph } : {}), timestamp: ts,
      }).catch(() => {});
    }
    await this.persistLog({
      level: 'error',
      category: 'tool',
      message: `Tool error: ${error}`,
      metadata: { toolId, toolName: tool?.toolName, error, ...(subgraph ? { subgraph } : {}) },
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
    if (isProgressEvent(event)) {
      const heartbeat = await touchRunProgress({
        redis: this.redis,
        runId: this.runId,
        automationRunId: this.automationRunId,
        automationRunsCollection: this.automationRunsCollection,
        generationId: this.generationId,
        generationsCollection: this.generationsCollection,
        stateTtlSeconds: this.stateTtl,
      });
      if (this.state && heartbeat.redisUpdated) {
        this.state.lastProgressAt = heartbeat.lastProgressAt;
      }
      // Keep this run's automation concurrency slot alive. A live run must never
      // age out of its cap slot; only a crashed/zombie run (which stops emitting
      // progress) does. No-op for non-automation runs.
      await this.heartbeatConcurrencySlot();
    }
    // Fire-and-forget archive job — non-blocking, non-fatal
    this._enqueueArchive(event).catch(() => {});

    // Forward audio_chunk to the conversation stream so the chat UI receives
    // server-side TTS audio. Catches BOTH the publishAudioChunk() path and the
    // AudioStreamPipeline.tryPublish() path (which calls publish() directly).
    // ConversationPublisher marks audio_chunk as EPHEMERAL — it is published to
    // pub/sub only and is NOT written to the replay list or archived to Mongo.
    if ((event as any).type === 'audio_chunk' && this.convPublisher && this.convMessageId) {
      const audioEvent = event as any;
      // mime derivation: the client's AudioPlaybackQueue decodes raw PCM16 and
      // reads the sample rate from a `rate=` mime parameter (defaulting 24k).
      // The streaming pipeline synthesizes PCM at Kokoro's native 24 kHz, so
      // 'pcm' maps to 'audio/pcm;rate=24000'. MP3 must NEVER be forwarded here
      // (the client has no MP3 demuxer — it would PCM-decode it into noise);
      // the pipeline no longer emits mp3, but map it defensively anyway.
      const fmt = audioEvent.format ?? 'pcm';
      const mimeType =
        fmt === 'pcm' ? 'audio/pcm;rate=24000'
        : fmt === 'mp3' ? 'audio/mpeg'
        : `audio/${fmt}`;
      this.convPublisher.publishAudioChunk(this.convMessageId, audioEvent.audio ?? '', mimeType).catch((err) => {
        console.warn('[RunPublisher] Conv forward audio_chunk failed:', err);
      });
    }
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
        // BullMQ does not allow colons in jobIds — use underscore separator
        jobId: `${this.runId}_${seq}`,
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

function isProgressEvent(event: RunEvent): boolean {
  switch (event.type) {
    case 'graph_start':
    case 'graph_complete':
    case 'graph_error':
    case 'node_start':
    case 'node_progress':
    case 'node_complete':
    case 'node_error':
    case 'chunk':
    case 'stdout':
    case 'stderr':
    case 'thinking_complete':
    case 'audio_chunk':
    case 'attachment':
    case 'component':
    case 'tool_start':
    case 'tool_progress':
    case 'tool_output':
    case 'tool_complete':
    case 'tool_error':
    case 'run_complete':
    case 'run_error':
    case 'run_failed':
    case 'run_interrupted':
      return true;
    case 'run_start':
    case 'status':
    case 'init':
      return false;
  }
}

/**
 * Strip well-known non-serialisable fields from the final graph state before
 * publishing it in a `run_complete` event.
 *
 * `buildInitialState()` in functions/run.ts injects live service objects into
 * state (neuronRegistry, memory, mcpClient, connectionManager, runPublisher,
 * _graphRegistry). LangGraph preserves these across the run, so they appear
 * in the final state. They must not be JSON-serialised — they contain
 * circular refs (ioredis connections, Mongoose models) that would blow up
 * StreamPublisher.publish().
 *
 * We keep every other field — including user-defined ones with or without a
 * leading underscore — so graphs can output anything they want.
 */
const NON_SERIALISABLE_STATE_KEYS = new Set([
  'neuronRegistry',
  'memory',
  'mcpClient',
  'connectionManager',
  'runPublisher',
  '_graphRegistry',
]);
function stripNonSerialisableStateFields(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (NON_SERIALISABLE_STATE_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Publish a terminal `run_error` + `run_failed` event WITHOUT a RunPublisher
 * instance.
 *
 * Use this from callers that may fail BEFORE they manage to initialise a
 * RunPublisher (e.g. the engine's `run()` entry point throwing from
 * loadGraph / runLock.acquire / loadUserSettings, or the worker processor's
 * outer catch). Without this, consumers subscribed to the run stream channel
 * (`dispatchToolCall`, `runStartupGraph`, `_subscribeAndRouteOutput`) have no
 * terminal event to latch onto and hang until their 60s timeout.
 *
 * Safe to call even when a RunPublisher DID manage to publish its own
 * run_error — the extra event is harmless; consumers have already resolved
 * on the first terminal event they see.
 *
 * Also pushes into the events log (`run:events:{runId}`) for replay parity,
 * and writes a minimal error state so status probes see `status: 'error'`.
 */
export async function publishRunError(
  redis: Redis,
  runId: string,
  error: string,
  options?: {
    errorStack?: string;
    stateTtl?: number;
    userId?: string;
    graphId?: string;
    conversationId?: string;
  },
): Promise<void> {
  const ttl = options?.stateTtl ?? RunConfig.STATE_TTL_SECONDS;
  const truncatedStack =
    options?.errorStack && options.errorStack.length > 4000
      ? options.errorStack.slice(0, 4000) + '\n...[truncated]'
      : options?.errorStack;
  const ts = Date.now();

  // Best-effort: update run state so status probes observe `error`.
  try {
    const existingRaw = await redis.get(RunKeys.state(runId));
    const existing = existingRaw ? (JSON.parse(existingRaw) as RunState) : null;
    const errorState: Partial<RunState> = {
      runId,
      userId: options?.userId ?? existing?.userId ?? 'unknown',
      graphId: options?.graphId ?? existing?.graphId ?? 'unknown',
      graphName: existing?.graphName ?? options?.graphId ?? 'unknown',
      conversationId: options?.conversationId ?? existing?.conversationId,
      status: 'error',
      error,
      startedAt: existing?.startedAt ?? ts,
      completedAt: ts,
      input: existing?.input ?? {},
      output: existing?.output ?? { content: '', thinking: '', data: {} },
      graph: existing?.graph ?? { executionPath: [], nodesExecuted: 0, nodeProgress: {} },
      tools: existing?.tools ?? [],
    };
    await redis.set(RunKeys.state(runId), JSON.stringify(errorState), 'EX', ttl);
    const convId = options?.conversationId ?? existing?.conversationId;
    if (convId) {
      // Compare-and-delete: only clear the pointer while it still names this run,
      // so a run that already took over the conversation keeps its live pointer.
      await releaseConversationPointerIfOwner(redis, convId, runId);
    }
  } catch {
    // non-fatal — the pub/sub terminal event is what unblocks consumers
  }

  // Publish BOTH terminal events through StreamPublisher (keeps events log
  // in sync with the pub/sub channel for replay).
  const errorEvent = {
    type: 'run_error' as const,
    error,
    errorStack: truncatedStack,
    runId,
    timestamp: ts,
  };
  const failedEvent = {
    type: 'run_failed' as const,
    error,
    errorStack: truncatedStack,
    runId,
    timestamp: ts,
  };
  try {
    const pub = new StreamPublisher({
      redis,
      channel: RunKeys.stream(runId),
      eventsKey: RunKeys.events(runId),
      ttl,
    });
    await pub.publish(errorEvent as any);
    await pub.publish(failedEvent as any);
  } catch (err) {
    // Fall back to a raw PUBLISH so at least SSE pub/sub consumers wake up
    try {
      await redis.publish(RunKeys.stream(runId), JSON.stringify(errorEvent));
      await redis.publish(RunKeys.stream(runId), JSON.stringify(failedEvent));
    } catch {
      console.error('[publishRunError] Failed to publish terminal event:', err);
    }
  }
}

/**
 * External interrupt helper.
 *
 * Publishes ANY message to the `run:interrupt:{runId}` channel — the engine's
 * subscriber (set up in `functions/run.ts` before graph invocation) will trip
 * its `AbortController`, halt the graph between nodes, and emit a terminal
 * `run_interrupted` event via RunPublisher.interrupt().
 *
 * Safe to call from any process (webapp API, worker concurrency block,
 * external automation hook). Returns the number of subscribers that received
 * the message — `0` means nobody is listening (run already done, or never
 * reached the subscription stage).
 *
 * @param redis - Redis client
 * @param runId - Run to interrupt
 * @param reason - Optional free-form reason (forwarded as `payload.reason`)
 * @returns Number of subscribers that received the interrupt
 */
export async function publishRunInterrupt(
  redis: Redis,
  runId: string,
  reason?: string,
): Promise<number> {
  const payload = JSON.stringify({
    type: 'interrupt',
    runId,
    reason,
    timestamp: Date.now(),
  });
  try {
    return await redis.publish(RunKeys.interrupt(runId), payload);
  } catch (err) {
    console.error('[publishRunInterrupt] PUBLISH failed:', err);
    return 0;
  }
}

/**
 * Component-event interaction payload (chat-interactive-widgets phase 10).
 *
 * Posted to the per-run inbox by the webapp endpoint
 * `POST /api/v1/runs/:runId/component-event` and drained by graph nodes
 * via the native `read_component_events` tool.
 */
export interface ComponentInteractionEvent {
  /** Stable id of the emitting chat-component spec. */
  componentId: string;
  /** Owning assistant message id (mirrors the spec). */
  messageId?: string;
  /** Payload provided by the user interaction (free-shape — schema
   *  enforcement is the calling node's responsibility). */
  payload: Record<string, unknown>;
  /** Optional userId of the interacting user (engine-side audit). */
  userId?: string;
  /** ISO-8601 emission timestamp. */
  timestamp: string;
}

/**
 * Publish a component-interaction event to a run.
 *
 * Two-step delivery (same pattern the conversation publisher uses):
 *   1. RPUSH onto the per-run inbox (`run:component-events:{runId}`) so a
 *      node calling `read_component_events` after the publish sees the
 *      payload regardless of subscriber timing.
 *   2. PUBLISH a notification on `run:component-event:{runId}` so an
 *      in-flight engine subscriber can wake immediately (no polling needed).
 *
 * Both keys live only for the run's lifetime — the list has an `EX` set
 * to RunConfig.STATE_TTL_SECONDS on first append.
 *
 * @returns Number of channel subscribers that received the notification
 *          (`0` means nobody is listening, e.g. run already done).
 */
export async function publishRunComponentEvent(
  redis: Redis,
  runId: string,
  event: ComponentInteractionEvent,
): Promise<number> {
  const inboxKey = RunKeys.componentEventsInbox(runId);
  const payload = JSON.stringify(event);
  try {
    const len = await redis.rpush(inboxKey, payload);
    if (len === 1) {
      try { await redis.expire(inboxKey, RunConfig.STATE_TTL_SECONDS); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[publishRunComponentEvent] RPUSH failed:', err);
  }
  try {
    return await redis.publish(RunKeys.componentEvent(runId), payload);
  } catch (err) {
    console.error('[publishRunComponentEvent] PUBLISH failed:', err);
    return 0;
  }
}

/**
 * Drain pending component-event payloads from a run's inbox.
 *
 * Atomic via LRANGE + LTRIM so concurrent drains don't return overlapping
 * results. Called by the native `read_component_events` tool from inside
 * a graph node; safe to call repeatedly between nodes.
 *
 * @param peek - If true, returns without removing the list contents.
 *               Default false (drain semantics).
 */
export async function drainRunComponentEvents(
  redis: Redis,
  runId: string,
  opts?: { peek?: boolean },
): Promise<ComponentInteractionEvent[]> {
  const inboxKey = RunKeys.componentEventsInbox(runId);
  try {
    const raw = await redis.lrange(inboxKey, 0, -1);
    if (!opts?.peek && raw.length > 0) {
      try { await redis.del(inboxKey); } catch { /* ignore */ }
    }
    return raw
      .map((s) => {
        try {
          return JSON.parse(s) as ComponentInteractionEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is ComponentInteractionEvent => e !== null);
  } catch (err) {
    console.error('[drainRunComponentEvents] LRANGE failed:', err);
    return [];
  }
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
    // Stale pointer names a run with no state — clear it, but only while it still
    // names THAT run: a fresh acquirer may have repointed between the reads above,
    // and its live pointer must survive (compare-and-delete against `runId`).
    await releaseConversationPointerIfOwner(redis, conversationId, runId);
    return null;
  }
  const state = JSON.parse(stateJson) as RunState;
  if (state.status === 'completed' || state.status === 'error') {
    await releaseConversationPointerIfOwner(redis, conversationId, runId);
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
