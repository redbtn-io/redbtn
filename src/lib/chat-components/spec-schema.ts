/**
 * @file src/lib/chat-components/spec-schema.ts
 *
 * Frozen v1 schema for `ChatComponentSpec` — the declarative shape an agent or tool
 * emits to render an interactive component inline in a chat message.
 *
 * This file is the SINGLE SOURCE OF TRUTH for the schema. Engine, worker, and webapp
 * all consume from here (re-exported via `@redbtn/redbtn`). Any change to this file
 * must update the sign-off doc at `~/assistant/chat-epic-4-interactive-signoff.md`
 * and pass the rejection tests in `tests/unit/chat-component-spec.test.ts`.
 *
 * See also: `chat-epic-4-interactive-signoff.md` for the decision history that froze
 * each invariant.
 */

/**
 * Semver-ish version string for the schema. Bumped on additive (minor) or breaking
 * (major) changes; coordinated with consumers.
 */
export const CHAT_COMPONENT_SPEC_SCHEMA_VERSION = '1.0.0' as const;

/**
 * Allowlist of `type` values in v1. Adding a new type is an additive change —
 * minor version bump.
 */
export const CHAT_COMPONENT_TYPES = ['button-group', 'info-panel', 'form'] as const;
export type ChatComponentType = typeof CHAT_COMPONENT_TYPES[number];

/**
 * Allowlist of feedback channels in v1.
 */
export const CHAT_COMPONENT_CHANNELS = ['followup', 'state-write', 'run-event'] as const;
export type ChatComponentChannel = typeof CHAT_COMPONENT_CHANNELS[number];

/**
 * Allowlist of surfaces this registry serves. v1 is chat-only.
 */
export const CHAT_COMPONENT_SURFACES = ['chat'] as const;
export type ChatComponentSurface = typeof CHAT_COMPONENT_SURFACES[number];

/** Maximum followup text length — security cap (see signoff §1, fork 6). */
export const FOLLOWUP_TEXT_MAX_LENGTH = 4000;

/**
 * Optional binding to Global State. Mirrors the dashboard widget binding shape so
 * existing dashboard widget components can be reused as chat components verbatim
 * (see phase 9 / `ciw-feedback-channels`).
 */
export interface WidgetBinding {
  source: 'globalState';
  namespace: string;
  key: string;
  /** Optional JSON-pointer fragment into the value. */
  path?: string;
  /** Optional transform expression (consumed by dashboards; opaque here). */
  transform?: string;
}

/**
 * The interaction descriptor — declares how a user action on the component feeds
 * back into the run/conversation. See the sign-off §1 fork 4 for v1 channels.
 */
export interface ChatComponentInteraction {
  channel: ChatComponentChannel;
  /** For `followup`: synthetic user message body. Required iff channel === 'followup'. */
  text?: string;
  /** For `state-write`: target namespace. Required iff channel === 'state-write'. */
  namespace?: string;
  /** For `state-write`: target key inside the namespace. Required iff channel === 'state-write'. */
  key?: string;
  /** For `state-write`: optional JSON pointer into the value. */
  path?: string;
  /** Human-readable label (e.g. button text). */
  label?: string;
}

/**
 * The frozen v1 `ChatComponentSpec`.
 *
 * Persistence/replay note: `answered`/`answeredAt`/`answeredBy` are written by the
 * client after a `followup` interaction so replay can render the spec inert.
 */
export interface ChatComponentSpec {
  /** Stable per-instance identifier (nanoid). */
  componentId: string;
  /** Allowlisted type id (see CHAT_COMPONENT_TYPES). */
  type: ChatComponentType;
  /** Free-shaped config bag — validated per-type by the catalog (phase 6). */
  config: Record<string, unknown>;
  /** Allowlist of surfaces this spec may render on. Must include 'chat'. */
  surfaces: ChatComponentSurface[];
  /** Optional Global State binding for live data. */
  binding?: WidgetBinding;
  /** Optional feedback descriptor. */
  interaction?: ChatComponentInteraction;
  /** Provenance — injected by engine on publish. */
  runId?: string;
  messageId?: string;
  emittedAt?: string;
  /** Replay markers — written by client after a followup interaction. */
  answered?: boolean;
  answeredAt?: string;
  answeredBy?: string;
}

/**
 * The JSON Schema representation of `ChatComponentSpec` v1. Exported for use by
 * consumers that wire schema-based validation (e.g. webapp ajv runtime, OpenAPI docs,
 * neuron `structuredOutput` payloads in a future phase).
 *
 * Equivalent to the `validateChatComponentSpec` hand-rolled validator below; keep
 * the two in sync — the test suite (`tests/unit/chat-component-spec.test.ts`)
 * exercises both paths against the same fixtures.
 */
export const CHAT_COMPONENT_SPEC_JSON_SCHEMA = {
  $id: `https://redbtn.io/schemas/chat-component-spec/${CHAT_COMPONENT_SPEC_SCHEMA_VERSION}.json`,
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'ChatComponentSpec',
  type: 'object',
  additionalProperties: false,
  required: ['componentId', 'type', 'config', 'surfaces'],
  properties: {
    componentId: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: [...CHAT_COMPONENT_TYPES] },
    config: { type: 'object' },
    surfaces: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: [...CHAT_COMPONENT_SURFACES] },
    },
    binding: {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'namespace', 'key'],
      properties: {
        source: { type: 'string', enum: ['globalState'] },
        namespace: { type: 'string', minLength: 1 },
        key: { type: 'string', minLength: 1 },
        path: { type: 'string' },
        transform: { type: 'string' },
      },
    },
    interaction: {
      type: 'object',
      additionalProperties: false,
      required: ['channel'],
      properties: {
        channel: { type: 'string', enum: [...CHAT_COMPONENT_CHANNELS] },
        text: { type: 'string', maxLength: FOLLOWUP_TEXT_MAX_LENGTH },
        namespace: { type: 'string', minLength: 1 },
        key: { type: 'string', minLength: 1 },
        path: { type: 'string' },
        label: { type: 'string' },
      },
    },
    runId: { type: 'string' },
    messageId: { type: 'string' },
    emittedAt: { type: 'string' },
    answered: { type: 'boolean' },
    answeredAt: { type: 'string' },
    answeredBy: { type: 'string' },
  },
} as const;

/**
 * Validation result. Mirrors the shape used elsewhere in the engine for parser-style
 * outputs; consumers can branch on `valid` without unwrapping a thrown exception.
 */
export type ValidateResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: string[] };

interface CheckCtx {
  path: string;
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function checkStringField(
  value: unknown,
  fieldPath: string,
  ctx: CheckCtx,
  opts?: { minLength?: number; maxLength?: number; allowedValues?: readonly string[] },
): string | undefined {
  if (typeof value !== 'string') {
    ctx.errors.push(`${fieldPath}: expected string, got ${typeof value}`);
    return undefined;
  }
  if (opts?.minLength != null && value.length < opts.minLength) {
    ctx.errors.push(`${fieldPath}: must be at least ${opts.minLength} character(s)`);
  }
  if (opts?.maxLength != null && value.length > opts.maxLength) {
    ctx.errors.push(`${fieldPath}: must be at most ${opts.maxLength} character(s)`);
  }
  if (opts?.allowedValues && !opts.allowedValues.includes(value)) {
    ctx.errors.push(
      `${fieldPath}: must be one of ${opts.allowedValues.join('|')} (got "${value}")`,
    );
  }
  return value;
}

const BINDING_KNOWN_KEYS = new Set(['source', 'namespace', 'key', 'path', 'transform']);
const INTERACTION_KNOWN_KEYS = new Set([
  'channel',
  'text',
  'namespace',
  'key',
  'path',
  'label',
]);
const SPEC_KNOWN_KEYS = new Set([
  'componentId',
  'type',
  'config',
  'surfaces',
  'binding',
  'interaction',
  'runId',
  'messageId',
  'emittedAt',
  'answered',
  'answeredAt',
  'answeredBy',
]);

function checkBinding(value: unknown, fieldPath: string, ctx: CheckCtx): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    ctx.errors.push(`${fieldPath}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!BINDING_KNOWN_KEYS.has(key)) {
      ctx.errors.push(`${fieldPath}: unknown field "${key}"`);
    }
  }
  checkStringField(value.source, `${fieldPath}.source`, ctx, { allowedValues: ['globalState'] });
  checkStringField(value.namespace, `${fieldPath}.namespace`, ctx, { minLength: 1 });
  checkStringField(value.key, `${fieldPath}.key`, ctx, { minLength: 1 });
  if (value.path !== undefined) checkStringField(value.path, `${fieldPath}.path`, ctx);
  if (value.transform !== undefined) checkStringField(value.transform, `${fieldPath}.transform`, ctx);
}

function checkInteraction(value: unknown, fieldPath: string, ctx: CheckCtx): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    ctx.errors.push(`${fieldPath}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!INTERACTION_KNOWN_KEYS.has(key)) {
      ctx.errors.push(`${fieldPath}: unknown field "${key}"`);
    }
  }
  const channel = checkStringField(value.channel, `${fieldPath}.channel`, ctx, {
    allowedValues: CHAT_COMPONENT_CHANNELS,
  });
  if (value.text !== undefined) {
    checkStringField(value.text, `${fieldPath}.text`, ctx, { maxLength: FOLLOWUP_TEXT_MAX_LENGTH });
  }
  if (value.namespace !== undefined) {
    checkStringField(value.namespace, `${fieldPath}.namespace`, ctx, { minLength: 1 });
  }
  if (value.key !== undefined) {
    checkStringField(value.key, `${fieldPath}.key`, ctx, { minLength: 1 });
  }
  if (value.path !== undefined) checkStringField(value.path, `${fieldPath}.path`, ctx);
  if (value.label !== undefined) checkStringField(value.label, `${fieldPath}.label`, ctx);

  // Channel-specific required fields.
  if (channel === 'followup') {
    if (typeof value.text !== 'string' || value.text.length === 0) {
      ctx.errors.push(`${fieldPath}.text: required when channel === 'followup'`);
    }
  } else if (channel === 'state-write') {
    if (typeof value.namespace !== 'string' || value.namespace.length === 0) {
      ctx.errors.push(`${fieldPath}.namespace: required when channel === 'state-write'`);
    }
    if (typeof value.key !== 'string' || value.key.length === 0) {
      ctx.errors.push(`${fieldPath}.key: required when channel === 'state-write'`);
    }
  }
}

/**
 * Validate a candidate value against the v1 `ChatComponentSpec` schema.
 *
 * Hand-rolled — no runtime ajv dependency in the engine. The exported JSON Schema
 * constant (`CHAT_COMPONENT_SPEC_JSON_SCHEMA`) is the schema-form mirror for
 * consumers that prefer ajv-based validation; both must accept/reject the same
 * inputs, asserted by the test suite.
 *
 * Returns a discriminated union so callers can branch without try/catch.
 */
export function validateChatComponentSpec(input: unknown): ValidateResult<ChatComponentSpec> {
  const ctx: CheckCtx = { path: '$', errors: [] };

  if (!isPlainObject(input)) {
    return {
      valid: false,
      errors: [`$: expected object, got ${Array.isArray(input) ? 'array' : typeof input}`],
    };
  }

  // Unknown top-level keys reject.
  for (const key of Object.keys(input)) {
    if (!SPEC_KNOWN_KEYS.has(key)) {
      ctx.errors.push(`$: unknown field "${key}"`);
    }
  }

  checkStringField(input.componentId, '$.componentId', ctx, { minLength: 1 });
  checkStringField(input.type, '$.type', ctx, { allowedValues: CHAT_COMPONENT_TYPES });

  if (!isPlainObject(input.config)) {
    ctx.errors.push(
      `$.config: expected object, got ${
        Array.isArray(input.config) ? 'array' : input.config === undefined ? 'undefined' : typeof input.config
      }`,
    );
  }

  if (!Array.isArray(input.surfaces)) {
    ctx.errors.push(`$.surfaces: expected array, got ${typeof input.surfaces}`);
  } else if (input.surfaces.length === 0) {
    ctx.errors.push(`$.surfaces: must be a non-empty array`);
  } else {
    input.surfaces.forEach((item, idx) => {
      checkStringField(item, `$.surfaces[${idx}]`, ctx, { allowedValues: CHAT_COMPONENT_SURFACES });
    });
  }

  checkBinding(input.binding, '$.binding', ctx);
  checkInteraction(input.interaction, '$.interaction', ctx);

  if (input.runId !== undefined) checkStringField(input.runId, '$.runId', ctx);
  if (input.messageId !== undefined) checkStringField(input.messageId, '$.messageId', ctx);
  if (input.emittedAt !== undefined) checkStringField(input.emittedAt, '$.emittedAt', ctx);
  if (input.answered !== undefined && typeof input.answered !== 'boolean') {
    ctx.errors.push(`$.answered: expected boolean, got ${typeof input.answered}`);
  }
  if (input.answeredAt !== undefined) checkStringField(input.answeredAt, '$.answeredAt', ctx);
  if (input.answeredBy !== undefined) checkStringField(input.answeredBy, '$.answeredBy', ctx);

  if (ctx.errors.length > 0) {
    return { valid: false, errors: ctx.errors };
  }
  return { valid: true, value: input as unknown as ChatComponentSpec };
}

/**
 * Helper for engine callers (e.g. the `emit_component` tool) that prefer to throw
 * on invalid input rather than branch on a result.
 */
export class ChatComponentSpecValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Invalid ChatComponentSpec: ${errors.join('; ')}`);
    this.name = 'ChatComponentSpecValidationError';
    this.errors = errors;
  }
}

export function assertChatComponentSpec(input: unknown): ChatComponentSpec {
  const result = validateChatComponentSpec(input);
  if (!result.valid) throw new ChatComponentSpecValidationError(result.errors);
  return result.value;
}
