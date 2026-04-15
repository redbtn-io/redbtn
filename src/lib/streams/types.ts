/**
 * Stream session pub/sub types and Redis key patterns.
 *
 * Stream sessions are scoped to a single realtime session lifecycle
 * (connect → events → disconnect). Multiple sessions can exist for
 * the same stream config over time.
 *
 * Redis keys:
 *   stream:events:{sessionId}   — event list (RPUSH, short TTL for replay)
 *   stream:channel:{sessionId}  — pub/sub channel for live subscribers
 *   stream:state:{sessionId}    — session state JSON (current status, counters)
 *   stream:result:{sessionId}   — pub/sub channel for async subgraph results
 */

// ---------------------------------------------------------------------------
// Redis key patterns
// ---------------------------------------------------------------------------

export const StreamSessionKeys = {
  /** Pub/sub channel for real-time events */
  channel: (sessionId: string) => `stream:channel:${sessionId}`,
  /** Event list for replay on reconnection (short TTL) */
  events: (sessionId: string) => `stream:events:${sessionId}`,
  /** Session state JSON */
  state: (sessionId: string) => `stream:state:${sessionId}`,
  /** Pub/sub channel for async subgraph result callbacks */
  result: (sessionId: string) => `stream:result:${sessionId}`,
} as const;

export const StreamSessionConfig = {
  /** Events list TTL — enough for reconnect replay */
  EVENTS_TTL_SECONDS: 5 * 60, // 5 minutes
  /** Session state TTL — longer, survives short disconnects */
  STATE_TTL_SECONDS: 60 * 60, // 1 hour
} as const;

// ---------------------------------------------------------------------------
// Event interfaces
// ---------------------------------------------------------------------------

interface BaseStreamEvent {
  timestamp: number;
}

/** Session lifecycle: session started, provider connected */
export interface StreamSessionStartEvent extends BaseStreamEvent {
  type: 'session_start';
  sessionId: string;
  streamId: string;
  provider: string;
}

/** Session lifecycle: session is ready for audio/text input */
export interface StreamSessionReadyEvent extends BaseStreamEvent {
  type: 'session_ready';
  sessionId: string;
}

/** Session lifecycle: session ended gracefully */
export interface StreamSessionEndEvent extends BaseStreamEvent {
  type: 'session_end';
  sessionId: string;
  reason: string;
}

/** Session lifecycle: session encountered an error */
export interface StreamSessionErrorEvent extends BaseStreamEvent {
  type: 'session_error';
  sessionId: string;
  error: string;
}

/** Audio arriving from client to provider */
export interface StreamAudioInEvent extends BaseStreamEvent {
  type: 'audio_in';
  sessionId: string;
  /** Base64-encoded audio data */
  data: string;
}

/** Audio arriving from provider to client */
export interface StreamAudioOutEvent extends BaseStreamEvent {
  type: 'audio_out';
  sessionId: string;
  /** Base64-encoded audio data */
  data: string;
}

/** Text input sent to the provider */
export interface StreamTextInEvent extends BaseStreamEvent {
  type: 'text_in';
  sessionId: string;
  text: string;
}

/** Text output received from the provider */
export interface StreamTextOutEvent extends BaseStreamEvent {
  type: 'text_out';
  sessionId: string;
  text: string;
}

/** Tool call issued by the realtime provider */
export interface StreamToolCallEvent extends BaseStreamEvent {
  type: 'tool_call';
  sessionId: string;
  toolName: string;
  args: unknown;
}

/** Result returned from a synchronous tool invocation */
export interface StreamToolResultEvent extends BaseStreamEvent {
  type: 'tool_result';
  sessionId: string;
  toolName: string;
  result: unknown;
}

/**
 * Result returned from an async (fire-and-forget) subgraph execution.
 * Published after the subgraph completes in the background.
 * The session manager subscribes to stream:result:{sessionId} and feeds
 * this back to the realtime provider as context text.
 */
export interface StreamSubgraphResultEvent extends BaseStreamEvent {
  type: 'subgraph_result';
  sessionId: string;
  toolName: string;
  result: unknown;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type StreamEvent =
  | StreamSessionStartEvent
  | StreamSessionReadyEvent
  | StreamSessionEndEvent
  | StreamSessionErrorEvent
  | StreamAudioInEvent
  | StreamAudioOutEvent
  | StreamTextInEvent
  | StreamTextOutEvent
  | StreamToolCallEvent
  | StreamToolResultEvent
  | StreamSubgraphResultEvent;

export type StreamEventType = StreamEvent['type'];
