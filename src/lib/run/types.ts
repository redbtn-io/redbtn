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
 */
export type RunStatus = 'pending' | 'running' | 'completed' | 'error';

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
}

export interface RunErrorEvent extends BaseEvent {
  type: 'run_error';
  error: string;
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
}

export interface ToolProgressEvent extends BaseEvent {
  type: 'tool_progress';
  toolId: string;
  step: string;
  progress?: number;
  data?: Record<string, unknown>;
}

export interface ToolCompleteEvent extends BaseEvent {
  type: 'tool_complete';
  toolId: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ToolErrorEvent extends BaseEvent {
  type: 'tool_error';
  toolId: string;
  error: string;
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
 * Reconnection replay event
 */
export interface InitEvent extends BaseEvent {
  type: 'init';
  state: RunState;
}

/**
 * Union of all run events
 */
export type RunEvent =
  | RunStartEvent
  | RunCompleteEvent
  | RunErrorEvent
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
  | ToolCompleteEvent
  | ToolErrorEvent
  | AudioChunkEvent
  | InitEvent;

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
   * Execution lock: `run:lock:{conversationId}`
   * Prevents multiple runs in the same conversation.
   * Same graph can run in different conversations simultaneously.
   */
  lock: (conversationId: string) => `run:lock:${conversationId}`,
  /** Active runs for user: `run:user:{userId}` */
  userRuns: (userId: string) => `run:user:${userId}`,
  /** Active run for conversation: `run:conversation:{conversationId}` */
  conversationRun: (conversationId: string) => `run:conversation:${conversationId}`,
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
}): ToolExecution {
  return {
    toolId: params.toolId,
    toolName: params.toolName,
    toolType: params.toolType,
    status: 'running',
    startedAt: Date.now(),
    steps: [],
  };
}
