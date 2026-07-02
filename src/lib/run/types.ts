/**
 * Run System Types
 *
 * Unified types for the run execution system. These types define the state schema
 * stored in Redis and the event protocol for pub/sub streaming.
 *
 * @module lib/run/types
 */

/**
 * Status of a run execution
 *
 * `'interrupted'` indicates the run was halted by an external actor via the
 * `run:interrupt:{runId}` Redis pub/sub channel (see RunKeys.interrupt).
 * State at the last completed node is preserved by MongoCheckpointer; a new
 * run can resume by passing `resumeFromRunId` in RunOptions.
 */
export type RunStatus = 'pending' | 'running' | 'completed' | 'error' | 'interrupted';

/**
 * Status of a node within a run
 */
export type NodeStatus = 'pending' | 'running' | 'completed' | 'error';

/**
 * Status of a tool execution
 */
export type ToolStatus = 'running' | 'completed' | 'error';

/**
 * A step in node or tool progress tracking
 */
export interface ProgressStep {
  name: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

/**
 * Progress tracking for a single node
 */
export interface NodeProgress {
  status: NodeStatus;
  nodeName: string;
  nodeType: string;
  startedAt?: number;
  completedAt?: number;
  duration?: number;
  steps: ProgressStep[];
  error?: string;
}

/**
 * A tool execution record
 */
/**
 * Subgraph origin tag for a tool execution. Present ONLY when the tool was
 * invoked inside a subgraph (a universal-node `graph` step). Top-level tools
 * have NO `subgraph` field. The webapp UI filters on this tag to hide/show
 * subgraph-originated tool entries on the message bubble.
 */
export interface SubgraphTag {
  /** Subgraph call depth — 1 for a direct subgraph, 2+ for nested subgraphs. */
  depth: number;
  /** graphId of the subgraph that invoked this tool. */
  graphId: string;
  /** Human-readable name of the subgraph. */
  name: string;
}

export interface ToolExecution {
  toolId: string;
  toolName: string;
  toolType: string;
  status: ToolStatus;
  startedAt: number;
  completedAt?: number;
  duration?: number;
  steps: Array<ProgressStep & { progress?: number }>;
  result?: unknown;
  error?: string;
  /**
   * Subgraph origin tag — present only when this tool ran inside a subgraph.
   * Top-level tools omit this field entirely.
   */
  subgraph?: SubgraphTag;
}

/**
 * Current status indicator for UI display
 */
export interface CurrentStatus {
  action: string;
  description?: string;
}

/**
 * Graph execution trace
 */
export interface GraphTrace {
  entryNodeId?: string;
  exitNodeId?: string;
  executionPath: string[];
  nodesExecuted: number;
  nodeProgress: Record<string, NodeProgress>;
}

/**
 * Run output data
 */
export interface RunOutput {
  /** Accumulated response text */
  content: string;
  /** Accumulated thinking/reasoning */
  thinking: string;
  /** Final graph state.data */
  data: Record<string, unknown>;
}

/**
 * Token usage metadata
 */
export interface TokenMetadata {
  model?: string;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
}

/**
 * Complete run state stored in Redis
 *
 * Key pattern: `run:{runId}`
 */
export interface RunState {
  runId: string;
  userId: string;
  graphId: string;
  graphName: string;
  /** Optional conversation ID for chat runs */
  conversationId?: string;
  status: RunStatus;
  startedAt: number;
  /**
   * ISO timestamp for the last observed forward progress. This is updated by
   * the shared progress heartbeat and is intentionally independent of total
   * runtime: long-running work stays alive by keeping this fresh.
   */
  lastProgressAt?: string;
  completedAt?: number;
  error?: string;
  currentStatus?: CurrentStatus;
  input: Record<string, unknown>;
  output: RunOutput;
  graph: GraphTrace;
  tools: ToolExecution[];
  metadata?: TokenMetadata;
}

/**
 * Base event with timestamp
 */
interface BaseEvent {
  timestamp: number;
}

/**
 * Run lifecycle events
 */
export interface RunStartEvent extends BaseEvent {
  type: 'run_start';
  graphId: string;
  graphName: string;
}

export interface RunCompleteEvent extends BaseEvent {
  type: 'run_complete';
  metadata?: TokenMetadata;
  /**
   * Process-style exit code for the run. Terminal bindings (the CLI / webapp
   * console) map this directly to a shell exit status:
   *   - `0`   — run completed successfully
   *   - `1`   — run failed (mirrored on `run_error`)
   *   - `130` — run interrupted (mirrored on `run_interrupted`)
   * A graph node may force a non-zero exit by writing `state.exitCode`
   * (any non-zero number) — `RunPublisher.complete()` honours it. Non-terminal
   * consumers can ignore this field entirely; it defaults to `0` on success.
   */
  exitCode?: number;
  /**
   * Final run output — the FULL final graph state.
   *
   * This is the complete state object as returned by the graph's terminal node.
   * Any field the graph writes to state root (e.g. `systemPrompt`, `setupOutput`,
   * arbitrary user-defined fields) is present here. Consumers can read whatever
   * they need without being constrained to a fixed shape.
   *
   * The following canonical aliases are always layered on top for convenience:
   *  - `content`   — the streamed response text (from RunState.output.content)
   *  - `thinking`  — the streamed reasoning text (from RunState.output.thinking)
   *  - `data`      — the legacy `state.data` bag (RunState.output.data)
   *  - `response`  — derived from `state.data.response`, `state.response`,
   *                  or `content` in that order, so consumers reading
   *                  `event.output?.response` keep working regardless of the
   *                  graph's state shape.
   *
   * Webapp's `runStartupGraph` and `dispatchToolCall` rely on `response`
   * (with graceful fallback to the full object). All other state fields —
   * whatever a specific graph happens to put at state root — are preserved
   * verbatim, so new graphs can output anything they want.
   */
  output?: Record<string, unknown> & {
    content?: string;
    thinking?: string;
    data?: Record<string, unknown>;
    response?: unknown;
  };
}

/**
 * Terminal failure event emitted by RunPublisher when a run errors out.
 *
 * Symmetric with `run_complete` — consumers MUST treat either name as a
 * terminal event (publishers emit both `run_error` and `run_failed` aliases
 * for backwards / forwards compatibility). Subscribers on the run stream
 * channel (`dispatchToolCall`, `runStartupGraph`, `_subscribeAndRouteOutput`)
 * should early-reject on receiving this to avoid hanging until their 60s
 * timeout.
 */
export interface RunErrorEvent extends BaseEvent {
  type: 'run_error' | 'run_failed';
  /** Human-readable error message */
  error: string;
  /** Optional error stack trace (may be truncated for payload size) */
  errorStack?: string;
  /** Run identifier — included on failure events for correlation */
  runId?: string;
  /** Process-style exit code — defaults to `1` for failures. See RunCompleteEvent.exitCode. */
  exitCode?: number;
}

/**
 * Status update event
 */
export interface StatusEvent extends BaseEvent {
  type: 'status';
  action: string;
  description?: string;
}

/**
 * Run interrupted event — emitted by RunPublisher.interrupt() when an
 * external actor halts the run via the `run:interrupt:{runId}` channel.
 *
 * Symmetric with `run_complete` and `run_error` — subscribers should treat
 * this as a terminal event that resolves their wait Promises. State at the
 * last completed node is persisted in MongoCheckpointer (graphcheckpoints
 * collection, 7-day TTL) and can be replayed by starting a new run with
 * `resumeFromRunId: <prevRunId>` in RunOptions.
 */
export interface RunInterruptedEvent extends BaseEvent {
  type: 'run_interrupted';
  /** Run identifier — included for correlation */
  runId: string;
  /**
   * Optional reason supplied by the interrupter (e.g. 'automation-superseded',
   * 'user-cancelled', 'god-stream-correction'). Free-form string.
   */
  reason?: string;
  /** Process-style exit code — defaults to `130` for interrupts. See RunCompleteEvent.exitCode. */
  exitCode?: number;
}

/**
 * Graph lifecycle events
 */
export interface GraphStartEvent extends BaseEvent {
  type: 'graph_start';
  runId: string;
  graphId: string;
  graphName: string;
  nodeCount: number;
  entryNodeId: string;
}

export interface GraphCompleteEvent extends BaseEvent {
  type: 'graph_complete';
  exitNodeId?: string;
  nodesExecuted: number;
  duration: number;
}

export interface GraphErrorEvent extends BaseEvent {
  type: 'graph_error';
  error: string;
  failedNodeId?: string;
}

/**
 * Node lifecycle events
 */
export interface NodeStartEvent extends BaseEvent {
  type: 'node_start';
  runId: string;
  nodeId: string;
  nodeType: string;
  nodeName: string;
}

export interface NodeProgressEvent extends BaseEvent {
  type: 'node_progress';
  nodeId: string;
  step: string;
  stepIndex?: number;
  totalSteps?: number;
  data?: Record<string, unknown>;
}

export interface NodeCompleteEvent extends BaseEvent {
  type: 'node_complete';
  nodeId: string;
  nextNodeId?: string;
  duration: number;
}

export interface NodeErrorEvent extends BaseEvent {
  type: 'node_error';
  nodeId: string;
  error: string;
}

/**
 * Content streaming events
 */
export interface ChunkEvent extends BaseEvent {
  type: 'chunk';
  content: string;
  thinking?: boolean;
}

export interface ThinkingCompleteEvent extends BaseEvent {
  type: 'thinking_complete';
}

/**
 * Tool execution events
 */
export interface ToolStartEvent extends BaseEvent {
  type: 'tool_start';
  toolId: string;
  toolName: string;
  toolType: string;
  input?: unknown;
  /**
   * What triggered this tool call.
   *  - `'step'`   — explicit graph-level `tool` step (default, backward-compatible)
   *  - `'neuron'` — LLM invoked the tool through `bindTools` on a neuron step
   *
   * Defaults to `'step'` when omitted to preserve existing event semantics.
   */
  triggeredBy?: 'step' | 'neuron';
  /**
   * When `triggeredBy === 'neuron'`, identifies the neuron step's `outputField`
   * (or step index) that owns this tool dispatch. Used by the UI to attribute
   * the tool bubble to its parent neuron.
   */
  neuronStepId?: string;
  /** Subgraph origin tag — present only for subgraph-originated tools. */
  subgraph?: SubgraphTag;
}

export interface ToolProgressEvent extends BaseEvent {
  type: 'tool_progress';
  toolId: string;
  step: string;
  progress?: number;
  data?: Record<string, unknown>;
  /** Subgraph origin tag — present only for subgraph-originated tools. */
  subgraph?: SubgraphTag;
}

export interface ToolOutputEvent extends BaseEvent {
  type: 'tool_output';
  toolId?: string;
  nodeId?: string;
  data: {
    chunk?: string;
    stream?: 'stdout' | 'stderr' | string;
    totalBytes?: number;
    [key: string]: unknown;
  };
}

export interface ToolCompleteEvent extends BaseEvent {
  type: 'tool_complete';
  toolId: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
  /** What triggered this tool call. See ToolStartEvent.triggeredBy. */
  triggeredBy?: 'step' | 'neuron';
  /** Owning neuron step id when triggeredBy === 'neuron'. */
  neuronStepId?: string;
  /** Subgraph origin tag — present only for subgraph-originated tools. */
  subgraph?: SubgraphTag;
}

export interface ToolErrorEvent extends BaseEvent {
  type: 'tool_error';
  toolId: string;
  error: string;
  /** What triggered this tool call. See ToolStartEvent.triggeredBy. */
  triggeredBy?: 'step' | 'neuron';
  /** Owning neuron step id when triggeredBy === 'neuron'. */
  neuronStepId?: string;
  /** Subgraph origin tag — present only for subgraph-originated tools. */
  subgraph?: SubgraphTag;
}

/**
 * Audio chunk event (server-side TTS)
 */
export interface AudioChunkEvent extends BaseEvent {
  type: 'audio_chunk';
  /** Base64-encoded audio data */
  audio: string;
  /** Sequential chunk index */
  index: number;
  /** Whether this is the final audio chunk for the response */
  isFinal: boolean;
  /** Audio format (e.g., 'mp3') */
  format: string;
}

/**
 * Structured terminal output events (Terminal binding).
 *
 * The graph engine itself rarely emits these directly — the Terminal binding
 * (webapp `/api/terminal/*`) usually derives `stdout`/`stderr` by mapping
 * `chunk`/`*_error` events. They exist so a graph node CAN emit explicit
 * stdout/stderr via `RunPublisher.stdout()` / `.stderr()` when it wants
 * shell-accurate output framing (e.g. a command node that distinguishes a
 * tool's stdout from its stderr).
 */
export interface StdoutEvent extends BaseEvent {
  type: 'stdout';
  /** Text chunk written to standard output. */
  chunk: string;
}

export interface StderrEvent extends BaseEvent {
  type: 'stderr';
  /** Text chunk written to standard error. */
  chunk: string;
}

/**
 * Reconnection replay event
 */
export interface InitEvent extends BaseEvent {
  type: 'init';
  state: RunState;
}

/**
 * Media kind for attachment events
 */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'document' | 'file';

/**
 * Attachment event — a file/image/video has been produced or received during a run.
 *
 * Consumers should prefer `url` for display/download. `base64` is only present
 * when the attachment is small and inline delivery is preferred (e.g. generated images).
 * `fileId` references the GridFS ObjectId in the `attachments` bucket when the file
 * has been persisted to the webapp's attachment store.
 */
export interface AttachmentEvent extends BaseEvent {
  type: 'attachment';
  /** Stable identifier for this attachment (nanoid, assigned by publisher or upload API) */
  attachmentId: string;
  /** Media category */
  kind: AttachmentKind;
  /** MIME type (e.g. 'image/png', 'video/mp4', 'application/pdf') */
  mimeType: string;
  /** Original filename */
  filename: string;
  /** File size in bytes */
  size: number;
  /** GridFS ObjectId string — present when persisted to the attachment store */
  fileId?: string;
  /** Publicly or privately accessible download URL */
  url?: string;
  /** Base64-encoded file data — present for small inline attachments */
  base64?: string;
  /** Optional human-readable caption */
  caption?: string;
}

/**
 * Component event — a renderable chat-component spec produced during a run.
 *
 * Structural sibling of `AttachmentEvent`: "the agent produced a non-text artifact"
 * — but instead of a file, the artifact is a declarative `ChatComponentSpec` that
 * the chat UI renders inline. The frozen v1 schema lives in
 * `lib/chat-components/spec-schema.ts` (signed off in
 * `~/assistant/chat-epic-4-interactive-signoff.md`).
 *
 * The full spec rides on `spec` so the SSE forwarder + archiver + client renderer
 * all consume the same shape. `componentId`/`runId`/`messageId` are duplicated at
 * the top level for convenience (matches the AttachmentEvent shape) so consumers
 * that index by these fields can do so without unwrapping `spec`.
 */
export interface ComponentEvent extends BaseEvent {
  type: 'component';
  /** Stable per-instance identifier (mirrors spec.componentId). */
  componentId: string;
  /** Run that produced this component (mirrors spec.runId — included for index/correlation). */
  runId: string;
  /** Owning message in the conversation (mirrors spec.messageId). Optional during the gap
   *  between message_start and the first component emission. */
  messageId?: string;
  /** The full declarative spec. Schema-validated by RunPublisher.publishComponent
   *  before publish; consumers may revalidate (defence-in-depth). */
  spec: Record<string, unknown>;
}

/**
 * Union of all run events
 */
export type RunEvent =
  | RunStartEvent
  | RunCompleteEvent
  | RunErrorEvent
  | RunInterruptedEvent
  | StatusEvent
  | GraphStartEvent
  | GraphCompleteEvent
  | GraphErrorEvent
  | NodeStartEvent
  | NodeProgressEvent
  | NodeCompleteEvent
  | NodeErrorEvent
  | ChunkEvent
  | ThinkingCompleteEvent
  | ToolStartEvent
  | ToolProgressEvent
  | ToolOutputEvent
  | ToolCompleteEvent
  | ToolErrorEvent
  | StdoutEvent
  | StderrEvent
  | AudioChunkEvent
  | InitEvent
  | AttachmentEvent
  | ComponentEvent;

/**
 * Event type discriminator
 */
export type RunEventType = RunEvent['type'];

// =============================================================================
// Redis Key Patterns
// =============================================================================

/**
 * Redis key patterns for the run system
 */
export const RunKeys = {
  /** Run state: `run:{runId}` */
  state: (runId: string) => `run:${runId}`,
  /** Pub/sub channel: `run:stream:{runId}` */
  stream: (runId: string) => `run:stream:${runId}`,
  /** Event log list: `run:events:{runId}` - stores all events for replay */
  events: (runId: string) => `run:events:${runId}`,
  /**
   * Shared state hash: `run:shared:{runId}`. Cross-branch state for
   * parallel branches inside the same run. Backs the `state.shared`
   * namespace exposed to graph configs (see `run/run-shared-state.ts`).
   * Lives only for the run's lifetime (TTL matches run state TTL).
   */
  shared: (runId: string) => `run:shared:${runId}`,
  /**
   * Auto-mirrored state hash: `run:autostate:{runId}`. Implicit
   * cross-branch overlay for parallel-context nodes — the engine
   * dual-writes any `outputField` here when a node executes inside
   * a parallel block, and overlays values back onto local state at
   * the start of every step so peer writes are visible without the
   * explicit `shared.<key>` prefix. See `run/run-auto-state.ts`.
   */
  autoState: (runId: string) => `run:autostate:${runId}`,
  /**
   * Execution lock: `run:lock:{conversationId}` or `run:lock:{conversationId}:{agentId}`
   * Prevents multiple runs of the SAME agent in the same conversation.
   * Different agents can run concurrently in the same conversation (group chat).
   */
  lock: (conversationId: string, agentId?: string) => agentId
    ? `run:lock:${conversationId}:${agentId}`
    : `run:lock:${conversationId}`,
  /** Active runs for user: `run:user:{userId}` */
  userRuns: (userId: string) => `run:user:${userId}`,
  /** Active run for conversation: `run:conversation:{conversationId}` */
  conversationRun: (conversationId: string) => `run:conversation:${conversationId}`,
  /**
   * External interrupt channel: `run:interrupt:{runId}`.
   *
   * Pub/sub-only — no state stored. When any actor publishes ANY message to
   * this channel, the engine's run subscriber (set up before graph invocation
   * in `functions/run.ts`) calls `AbortController.abort('interrupted')`. The
   * graph then halts cleanly between nodes; MongoCheckpointer has already
   * persisted state at the last completed node so a new run can resume by
   * passing `resumeFromRunId: <prevRunId>` in RunOptions.
   */
  interrupt: (runId: string) => `run:interrupt:${runId}`,
  /**
   * Interrupt-ACK channel: `run:interrupt:ack:{runId}`.
   *
   * Pub/sub-only — no state stored. Companion to `interrupt`. The webapp's
   * interrupt endpoint subscribes to this channel BEFORE publishing the
   * interrupt request, then waits up to 5 seconds for the worker to
   * confirm cancellation. The worker (engine's interrupt subscriber)
   * publishes a JSON payload here after invoking
   * `runControlRegistry.cancel(runId)` so the endpoint knows:
   *   - which worker handled the cancellation (workerId)
   *   - what node/step was running at the time
   *   - how many in-flight neuron calls were cancelled
   *
   * If the endpoint times out waiting for ACK, it force-kills the run by
   * marking it `interrupted` in MongoDB and clearing Redis state. This
   * covers worker-crash scenarios where the cancel never lands.
   *
   * NOTE: The channel name is part of the public API contract between the
   * engine and the webapp interrupt endpoint. Do not change it without
   * coordinating both sides.
   */
  interruptAck: (runId: string) => `run:interrupt:ack:${runId}`,
  /**
   * Component-event inbound channel: `run:component-event:{runId}`.
   *
   * Live in-run interaction channel for the chat-interactive-widgets feature.
   * The webapp endpoint `POST /api/v1/runs/:runId/component-event` publishes
   * a JSON `ComponentInteractionEvent` here; the engine appends it to the
   * per-run inbox (`componentEvents`), which graph nodes drain via the
   * native `read_component_events` tool.
   *
   * Mirrors the interrupt channel's pub/sub design — built on the same
   * primitive intentionally so cancellation/inbound semantics share an
   * abstraction (see `subscribeForComponentEvents` in `functions/run.ts`).
   */
  componentEvent: (runId: string) => `run:component-event:${runId}`,
  /**
   * Component-event inbox: `run:component-events:{runId}` (note the plural
   * suffix — distinct from the channel above).
   *
   * Redis list that buffers component-event payloads until a graph node
   * drains them via `read_component_events`. Lives only for the run's
   * lifetime (TTL matches run state TTL).
   */
  componentEventsInbox: (runId: string) => `run:component-events:${runId}`,
} as const;

// =============================================================================
// Configuration
// =============================================================================

/**
 * Default configuration values
 */
export const RunConfig = {
  /** Default TTL for run state in Redis (1 hour) */
  STATE_TTL_SECONDS: 60 * 60,
  /**
   * Default run-progress stale window (30 minutes).
   *
   * A run is considered alive when its lastProgressAt heartbeat is newer than
   * this window. This is deliberately independent of total runtime: legitimate
   * long-running work can run for hours as long as progress keeps advancing.
   */
  RUN_PROGRESS_STALE_MS: 30 * 60 * 1000,
  /**
   * Minimum interval between AutomationRun.lastProgressAt Mongo writes.
   * Redis run state is still refreshed on every progress event; this only
   * coalesces the durable mirror so chatty streaming tools do not write to
   * Mongo on every chunk.
   */
  AUTOMATION_RUN_HEARTBEAT_THROTTLE_MS: 15 * 1000,
  /** Default timeout waiting for client ready signal (30 seconds) */
  READY_TIMEOUT_MS: 30000,
  /** Default lock TTL (5 minutes) - prevents zombie locks */
  LOCK_TTL_SECONDS: 60 * 5,
  /** Lock renewal interval (every 30 seconds while running) */
  LOCK_RENEWAL_INTERVAL_MS: 30000,
} as const;

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create an initial RunState
 */
export function createInitialRunState(params: {
  runId: string;
  userId: string;
  graphId: string;
  graphName: string;
  input: Record<string, unknown>;
  conversationId?: string;
}): RunState {
  return {
    runId: params.runId,
    userId: params.userId,
    graphId: params.graphId,
    graphName: params.graphName,
    conversationId: params.conversationId,
    status: 'pending',
    startedAt: Date.now(),
    lastProgressAt: new Date().toISOString(),
    input: params.input,
    output: {
      content: '',
      thinking: '',
      data: {},
    },
    graph: {
      executionPath: [],
      nodesExecuted: 0,
      nodeProgress: {},
    },
    tools: [],
  };
}

/**
 * Create an initial NodeProgress entry
 */
export function createNodeProgress(params: {
  nodeName: string;
  nodeType: string;
}): NodeProgress {
  return {
    status: 'pending',
    nodeName: params.nodeName,
    nodeType: params.nodeType,
    steps: [],
  };
}

/**
 * Create an initial ToolExecution entry
 */
export function createToolExecution(params: {
  toolId: string;
  toolName: string;
  toolType: string;
  /** Subgraph origin tag — omit for top-level tools. */
  subgraph?: SubgraphTag;
}): ToolExecution {
  return {
    toolId: params.toolId,
    toolName: params.toolName,
    toolType: params.toolType,
    status: 'running',
    startedAt: Date.now(),
    steps: [],
    // Only attach when present so top-level tools have no `subgraph` field.
    ...(params.subgraph ? { subgraph: params.subgraph } : {}),
  };
}
