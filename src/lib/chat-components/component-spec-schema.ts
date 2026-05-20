/**
 * @file Frozen schema contract for ChatComponentSpec.
 *
 * Single source of truth for the chat-interactive-widgets epic. Both engine
 * (`emit_component` native tool) and webapp (render boundary in
 * `useConversationStream` + `ChatComponentBlock`) import from this module.
 *
 * Design doc: explanations/chat-interactive-widgets-design.md
 *
 * This file exports BOTH a JSON Schema constant (for ajv on the client) AND a
 * matching zod schema (for engine-side validation without adding an ajv
 * dependency). A parity test in
 * `redbtn/tests/chat-components/component-spec-schema.test.ts` locks the two
 * representations together against shared fixtures.
 */

import { z } from 'zod';

// =============================================================================
// Allowlist
// =============================================================================

/**
 * The v1 allowlist of chat component types. Any spec carrying a `type` outside
 * this set is rejected at the engine `emit_component` boundary AND a second
 * time at the client render boundary.
 */
export const CHAT_COMPONENT_TYPES = [
  'button-group',
  'info-panel',
  'form',
  'choice-list',
  'data-card',
  'confirm',
] as const;

export type ChatComponentType = (typeof CHAT_COMPONENT_TYPES)[number];

export const CHAT_COMPONENT_INTERACTION_CHANNELS = [
  'followup',
  'state-write',
  'run-event',
] as const;

export type ChatComponentInteractionChannel =
  (typeof CHAT_COMPONENT_INTERACTION_CHANNELS)[number];

// =============================================================================
// TS types
// =============================================================================

/** Reuses dashboards' WidgetBinding shape (kept structurally compatible). */
export interface ChatComponentBinding {
  source: 'globalState';
  namespace: string;
  key: string;
  path?: string;
  transform?: Record<string, unknown>;
}

export interface ChatComponentInteraction {
  channel: ChatComponentInteractionChannel;
  /** `followup`: body of the synthetic user message. */
  followupTemplate?: string;
  /** `state-write`: target Global State namespace. */
  writeNamespace?: string;
  /** `state-write`: target Global State key. */
  writeKey?: string;
  /** `state-write`: optional JSON Pointer-ish path within the value. */
  writePath?: string;
  /** `run-event` (deferred): tag forwarded on the component_event payload. */
  runEventTag?: string;
}

export interface ChatComponentProvenance {
  runId: string;
  messageId?: string;
  nodeId?: string;
}

export interface ChatComponentResponded {
  /** ISO 8601 timestamp of first interaction. */
  at: string;
  /** userId that performed the action. */
  by: string;
  via: ChatComponentInteractionChannel;
  summary?: string;
}

export interface ChatComponentSpec {
  componentId: string;
  type: ChatComponentType;
  config: Record<string, unknown>;
  binding?: ChatComponentBinding;
  interaction?: ChatComponentInteraction;
  /** Must include 'chat' for the chat surface to render the spec. */
  surfaces: string[];
  provenance: ChatComponentProvenance;
  responded?: ChatComponentResponded;
}

// =============================================================================
// JSON Schema (Draft-07) — the contract clients (ajv) validate against
// =============================================================================

/**
 * Frozen JSON Schema for a ChatComponentSpec. Draft-07 to match the dashboards
 * widget catalog configSchema style. Closed shape — additionalProperties is
 * false at every level so agents cannot smuggle unknown keys.
 */
export const CHAT_COMPONENT_SPEC_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://redbtn.io/schemas/chat-component-spec.json',
  title: 'ChatComponentSpec',
  type: 'object',
  additionalProperties: false,
  required: ['componentId', 'type', 'config', 'surfaces', 'provenance'],
  properties: {
    componentId: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: [...CHAT_COMPONENT_TYPES] },
    config: { type: 'object' },
    binding: {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'namespace', 'key'],
      properties: {
        source: { const: 'globalState' },
        namespace: { type: 'string', minLength: 1 },
        key: { type: 'string', minLength: 1 },
        path: { type: 'string' },
        transform: { type: 'object' },
      },
    },
    interaction: {
      type: 'object',
      additionalProperties: false,
      required: ['channel'],
      properties: {
        channel: {
          type: 'string',
          enum: [...CHAT_COMPONENT_INTERACTION_CHANNELS],
        },
        followupTemplate: { type: 'string' },
        writeNamespace: { type: 'string', minLength: 1 },
        writeKey: { type: 'string', minLength: 1 },
        writePath: { type: 'string' },
        runEventTag: { type: 'string' },
      },
      allOf: [
        {
          if: { properties: { channel: { const: 'state-write' } } },
          then: { required: ['channel', 'writeNamespace', 'writeKey'] },
        },
        {
          if: { properties: { channel: { const: 'followup' } } },
          then: { required: ['channel', 'followupTemplate'] },
        },
      ],
    },
    surfaces: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
      contains: { const: 'chat' },
    },
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: {
        runId: { type: 'string', minLength: 1 },
        messageId: { type: 'string' },
        nodeId: { type: 'string' },
      },
    },
    responded: {
      type: 'object',
      additionalProperties: false,
      required: ['at', 'by', 'via'],
      properties: {
        at: { type: 'string', minLength: 1 },
        by: { type: 'string', minLength: 1 },
        via: {
          type: 'string',
          enum: [...CHAT_COMPONENT_INTERACTION_CHANNELS],
        },
        summary: { type: 'string' },
      },
    },
  },
} as const;

// =============================================================================
// zod schema — engine-side validator (no ajv dep in the engine)
// =============================================================================

const bindingZ = z
  .object({
    source: z.literal('globalState'),
    namespace: z.string().min(1),
    key: z.string().min(1),
    path: z.string().optional(),
    transform: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const interactionZ = z
  .object({
    channel: z.enum(CHAT_COMPONENT_INTERACTION_CHANNELS),
    followupTemplate: z.string().optional(),
    writeNamespace: z.string().min(1).optional(),
    writeKey: z.string().min(1).optional(),
    writePath: z.string().optional(),
    runEventTag: z.string().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.channel !== 'state-write' ||
      (v.writeNamespace !== undefined && v.writeKey !== undefined),
    {
      message:
        "interaction.channel='state-write' requires writeNamespace and writeKey",
      path: ['writeNamespace'],
    },
  )
  .refine(
    (v) => v.channel !== 'followup' || v.followupTemplate !== undefined,
    {
      message:
        "interaction.channel='followup' requires followupTemplate",
      path: ['followupTemplate'],
    },
  );

const provenanceZ = z
  .object({
    runId: z.string().min(1),
    messageId: z.string().optional(),
    nodeId: z.string().optional(),
  })
  .strict();

const respondedZ = z
  .object({
    at: z.string().min(1),
    by: z.string().min(1),
    via: z.enum(CHAT_COMPONENT_INTERACTION_CHANNELS),
    summary: z.string().optional(),
  })
  .strict();

/**
 * Zod schema for ChatComponentSpec. Closed shape — `.strict()` rejects unknown
 * top-level keys to match the JSON Schema's `additionalProperties: false`.
 */
export const chatComponentSpecZod = z
  .object({
    componentId: z.string().min(1),
    type: z.enum(CHAT_COMPONENT_TYPES),
    config: z.record(z.string(), z.unknown()),
    binding: bindingZ.optional(),
    interaction: interactionZ.optional(),
    surfaces: z
      .array(z.string().min(1))
      .min(1)
      .refine((arr) => arr.includes('chat'), {
        message: "surfaces must include 'chat' for chat-surface rendering",
      }),
    provenance: provenanceZ,
    responded: respondedZ.optional(),
  })
  .strict();

// =============================================================================
// Convenience validator
// =============================================================================

export type ValidateResult =
  | { ok: true; value: ChatComponentSpec }
  | { ok: false; errors: string[] };

/**
 * Validate a candidate value against the frozen ChatComponentSpec contract.
 *
 * Returns a discriminated result with either the typed value or a list of
 * human-readable error strings. Engine-side `emit_component` is expected to
 * call this and refuse to publish if `ok === false`.
 */
export function validateChatComponentSpec(value: unknown): ValidateResult {
  const parsed = chatComponentSpecZod.safeParse(value);
  if (parsed.success) {
    return { ok: true, value: parsed.data as ChatComponentSpec };
  }
  const errors = parsed.error.issues.map(
    (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
  );
  return { ok: false, errors };
}
