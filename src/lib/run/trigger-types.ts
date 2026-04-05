/**
 * Unified Run & Trigger Types
 *
 * Defines the canonical shape for every graph execution regardless of how it
 * was initiated — chat message, webhook, cron schedule, email, Discord message,
 * or direct API call.
 *
 * Phase 1 of the Unified Run/Trigger architecture.
 * See: explanations/UNIFIED-RUN-TRIGGERS.md
 *
 * @module lib/run/trigger-types
 */

// =============================================================================
// Trigger Types
// =============================================================================

/**
 * All first-class trigger sources understood by the platform.
 *
 * - chat       → user typed a message in the redbtn chat UI or REST client
 * - webhook    → external HTTP POST to /api/v1/webhooks/[automationId]
 * - cron       → scheduler fired a repeatable BullMQ job
 * - email      → email forwarding service POSTed to the webhook endpoint
 * - discord    → Discord bot routed a message (was previously ad-hoc payload.type)
 * - api        → direct POST to /api/v1/chat/completions with source=api
 * - scheduled  → one-shot delayed job (nextRunAt override on an automation)
 */
export type TriggerType =
  | 'chat'
  | 'webhook'
  | 'cron'
  | 'email'
  | 'discord'
  | 'api'
  | 'scheduled';

/**
 * Source details captured at the edge (API route / bot adapter).
 * All fields are optional — capture what is available.
 */
export interface TriggerSource {
  /** Originating application / adapter */
  application?: string;
  /** Device form-factor (for chat triggers) */
  device?: 'phone' | 'speaker' | 'web' | 'api';
  /** Raw User-Agent header */
  userAgent?: string;
  /** Caller IP (first value of X-Forwarded-For) */
  ip?: string;
}

/**
 * Trigger-specific metadata that varies by trigger type.
 *
 * Common examples:
 *   chat    → { conversationSource: 'terminal' | 'chat' }
 *   webhook → { contentType: 'application/json', ip: '...' }
 *   discord → { channelId: '...', guildId: '...', authorId: '...' }
 *   cron    → { cronExpression: '0 * * * *', scheduleMode: 'cron' | 'interval' }
 *   email   → { from: '...', subject: '...', to: '...' }
 *   api     → { clientId: '...', oauthScopes: [...] }
 */
export type TriggerMetadata = Record<string, unknown>;

/**
 * Full trigger descriptor attached to every TriggeredRun.
 */
export interface Trigger {
  /** Primary trigger classification */
  type: TriggerType;
  /** Edge-level source info */
  source?: TriggerSource;
  /** Trigger-specific structured metadata */
  metadata?: TriggerMetadata;
}

// =============================================================================
// Unified Run Request
// =============================================================================

/**
 * Canonical shape for submitting a graph run from any trigger source.
 *
 * Both the graph processor and the automation processor will eventually
 * accept (and produce) this shape. Phase 2 will migrate the BullMQ job
 * payloads to use this as the single job data type.
 *
 * Fields marked optional remain backward-compatible with existing processors.
 */
export interface TriggeredRun {
  // ── Core identity ──────────────────────────────────────────────────────────

  /** Unique run identifier. If omitted, the processor generates one. */
  runId?: string;

  /** User who owns this run. Required for auth, connection fetching, secrets. */
  userId: string;

  /** Graph to execute. If omitted, the user's default graph is used. */
  graphId?: string;

  // ── Input ─────────────────────────────────────────────────────────────────

  /**
   * Raw input passed to the graph. The enrich-input pipeline transforms
   * this before the graph sees it — secrets + state refs are resolved,
   * automation configOverrides and conversation graphInputs are merged in.
   */
  input: Record<string, unknown>;

  // ── Trigger ───────────────────────────────────────────────────────────────

  /** Describes how and from where this run was initiated. */
  trigger: Trigger;

  // ── Optional attachments ──────────────────────────────────────────────────

  /**
   * Conversation to attach this run to.
   * Present for chat triggers and for automations that write back to a conversation.
   */
  conversationId?: string;

  /**
   * Automation to attach this run to.
   * When set, the enrich-input pipeline loads:
   *   - configOverrides (merged into _configOverrides)
   *   - secretNames     (resolved into _secrets + placeholders replaced)
   *   - inputMapping    (merged into input before rawInput)
   * and injects _automation metadata.
   */
  automationId?: string;

  // ── Execution options ──────────────────────────────────────────────────────

  /** Publish SSE events via Redis pub/sub during execution. Default true. */
  stream?: boolean;

  /**
   * Maximum execution time in milliseconds.
   * 0 = no limit (default). Maps to automation inputMapping.timeout.
   */
  timeoutMs?: number;
}

// =============================================================================
// Enriched Run Input (output of enrich-input pipeline)
// =============================================================================

/**
 * The enriched input object that the graph actually receives as `state.data`.
 *
 * The enrich-input pipeline starts from TriggeredRun.input and progressively
 * adds well-known underscore-prefixed system fields.
 */
export interface EnrichedInput extends Record<string, unknown> {
  /**
   * Resolved secret values by name.
   * Only present when at least one secret was resolved.
   * Graphs read individual secrets from _secrets.SECRET_NAME.
   */
  _secrets?: Record<string, string>;

  /**
   * Resolved global-state values by "namespace.key" composite key.
   * Only present when at least one state ref was found.
   */
  _state?: Record<string, unknown>;

  /**
   * Merged config overrides from automation + conversation.
   * Universale node reads these via {{parameters.X}} template resolution.
   */
  _configOverrides?: Record<string, unknown>;

  /**
   * Automation context — injected when automationId is present.
   */
  _automation?: {
    automationId: string;
    triggeredBy: string;
    runId: string;
  };

  /**
   * Trigger descriptor forwarded into graph state.
   * Replaces ad-hoc state.data.triggerType / state.data.input.type conventions.
   */
  _trigger?: Trigger;
}

// =============================================================================
// Enrichment Result
// =============================================================================

/**
 * Result returned by enrichInput().
 * Contains the enriched input plus derived metadata the processor needs.
 */
export interface EnrichmentResult {
  /** Fully enriched input ready to pass to run() */
  input: EnrichedInput;

  /** Resolved graphId (may come from automationDoc if not supplied) */
  graphId: string;

  /** Execution timeout in ms (0 = none) */
  timeoutMs: number;

  /** Number of secrets injected (for logging) */
  secretsInjected: number;

  /** Number of state values injected (for logging) */
  stateValuesInjected: number;
}

// =============================================================================
// Backward-Compatible Type Aliases
// =============================================================================
// These allow existing code that imports specific trigger-string literals to
// continue working without changes in Phase 1.

/** @deprecated Use TriggerType instead */
export type AutomationTriggeredBy = 'manual' | 'cron' | 'webhook' | 'event' | 'email';

/** Map from legacy AutomationTriggeredBy values to TriggerType */
export const LEGACY_TRIGGER_MAP: Record<AutomationTriggeredBy, TriggerType> = {
  manual:  'api',
  cron:    'cron',
  webhook: 'webhook',
  event:   'webhook',
  email:   'email',
} as const;

/**
 * Convert a legacy automation triggeredBy string to the canonical TriggerType.
 * Falls back to 'webhook' for unknown values.
 */
export function toTriggerType(legacy: string): TriggerType {
  return (LEGACY_TRIGGER_MAP as Record<string, TriggerType>)[legacy] ?? 'webhook';
}
