/**
 * Conversation-level streaming types and Redis key patterns.
 *
 * Unlike run streams (scoped to a single execution), conversation streams
 * are persistent channels that any producer can publish to -- runs, automations,
 * the push_message tool, or external triggers.
 */

export const ConversationKeys = {
  /** Pub/sub channel for real-time events */
  stream: (conversationId: string) => `conversation:stream:${conversationId}`,
  /** Event list for replay on reconnection (short TTL) */
  events: (conversationId: string) => `conversation:events:${conversationId}`,
} as const;

export const ConversationConfig = {
  /** Events list TTL -- just enough for reconnection, not long-term history */
  EVENTS_TTL_SECONDS: 5 * 60, // 5 minutes
} as const;

// Event types
export interface ConversationMessageEvent {
  type: 'message';
  messageId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface ConversationMessageStartEvent {
  type: 'message_start';
  messageId: string;
  role?: string;
  sourceRunId?: string;
  /** Optional metadata propagated through to the archiver and the UI.
   *  Example: `{ audio: true }` for a voice turn so the UI can render a
   *  mic icon on the bubble. */
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface ConversationMessageChunkEvent {
  type: 'message_chunk';
  messageId: string;
  content: string;
  /** When true, this chunk is thinking/reasoning text (shown in collapsible bubble) */
  thinking?: boolean;
  timestamp: number;
}

export interface ConversationMessageCompleteEvent {
  type: 'message_complete';
  messageId: string;
  finalContent?: string;
  timestamp: number;
}

export interface ConversationMessageStoredEvent {
  type: 'message_stored';
  messageId: string;
  timestamp: number;
}

export interface ConversationTypingEvent {
  type: 'typing';
  isTyping: boolean;
  sourceRunId?: string;
  timestamp: number;
}

export interface ConversationStatusEvent {
  type: 'status';
  action: string;
  description?: string;
  timestamp: number;
}

// ── Run-aware conversation events ──
// These are published by RunPublisher when a run has a conversationId.
// They allow the chat UI to group thinking/tools/content into unified run bubbles.

export interface ConversationRunStartEvent {
  type: 'run_start';
  runId: string;
  messageId: string;
  graphId: string;
  graphName: string;
  timestamp: number;
}

export interface ConversationThinkingChunkEvent {
  type: 'thinking_chunk';
  runId: string;
  messageId: string;
  content: string;
  timestamp: number;
}

export interface ConversationContentChunkEvent {
  type: 'content_chunk';
  runId: string;
  messageId: string;
  content: string;
  timestamp: number;
}

export interface ConversationToolEvent {
  type: 'tool_event';
  runId: string;
  event: {
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
  };
  timestamp: number;
}

export interface ConversationRunCompleteEvent {
  type: 'run_complete';
  runId: string;
  messageId: string;
  finalContent?: string;
  timestamp: number;
}

export interface ConversationRunErrorEvent {
  type: 'run_error';
  runId: string;
  messageId: string;
  error: string;
  timestamp: number;
}

/**
 * Attachment event forwarded from RunPublisher when a file is produced or received.
 * The chat UI uses this to render inline image/video/document previews.
 *
 * `messageId` ties the attachment to the in-flight assistant message so the
 * conversation archiver can persist it to the correct messages array entry (W-4).
 */
export interface ConversationAttachmentEvent {
  type: 'attachment';
  runId: string;
  /** The in-flight assistant message this attachment belongs to */
  messageId?: string;
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
}

// ── Live/stream-specific conversation events ──
// Published by SessionManager when a realtime stream session is active.

export interface ConversationAudioChunkEvent {
  type: 'audio_chunk';
  messageId: string;
  data: string; // base64
  mimeType: string;
  connectionId?: string;
  timestamp: number;
}

export interface ConversationInputTranscriptionEvent {
  type: 'input_transcription';
  text: string;
  messageId?: string;
  isFinal?: boolean;
  timestamp: number;
}

export interface ConversationOutputTranscriptionEvent {
  type: 'output_transcription';
  messageId: string;
  text: string;
  timestamp: number;
}

export interface ConversationTurnCompleteEvent {
  type: 'turn_complete';
  messageId?: string;
  connectionId?: string;
  timestamp: number;
}

export interface ConversationInterruptedEvent {
  type: 'interrupted';
  messageId?: string;
  timestamp: number;
}

export type ConversationEvent =
  | ConversationMessageEvent
  | ConversationMessageStartEvent
  | ConversationMessageChunkEvent
  | ConversationMessageCompleteEvent
  | ConversationMessageStoredEvent
  | ConversationTypingEvent
  | ConversationStatusEvent
  | ConversationRunStartEvent
  | ConversationThinkingChunkEvent
  | ConversationContentChunkEvent
  | ConversationToolEvent
  | ConversationRunCompleteEvent
  | ConversationRunErrorEvent
  | ConversationAttachmentEvent
  | ConversationAudioChunkEvent
  | ConversationInputTranscriptionEvent
  | ConversationOutputTranscriptionEvent
  | ConversationTurnCompleteEvent
  | ConversationInterruptedEvent;
