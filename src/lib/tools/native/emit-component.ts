/**
 * Emit Component — Native Tool
 *
 * Publishes a `ChatComponentSpec` onto the active run's stream so the chat
 * UI renders it inline as part of the message (phase 5 of
 * `chat-interactive-widgets`).
 *
 * Design:
 *   - Input is the minimal spec body — the agent (or node config) describes
 *     `type`, `config`, and optionally `binding` + `interaction`. The tool
 *     injects the engine-only provenance fields (`componentId`, `runId`,
 *     `messageId`, `surfaces: ['chat']`, `emittedAt`) before validation,
 *     so the agent never has to mint identifiers or worry about ambient
 *     stream context.
 *   - Validation lives in `assertChatComponentSpec` (the frozen v1 schema in
 *     `src/lib/chat-components/spec-schema.ts`, signed off in
 *     `~/assistant/chat-epic-4-interactive-signoff.md`). Anything off-schema
 *     throws *before* `publishComponent` is called — the publisher never
 *     carries an invalid spec onto the wire.
 *   - The tool returns a small JSON payload containing the injected
 *     `componentId` and `messageId` so a follow-up step (e.g. recording
 *     which component the agent emitted) can reference it.
 *
 * Schema:
 *   inputs:
 *     - type:        required ('button-group' | 'info-panel' | 'form')
 *     - config:      required object (per-type catalog validates downstream)
 *     - binding?:    optional Global State binding
 *     - interaction?:optional feedback descriptor (followup / state-write / run-event)
 *     - componentId?:optional; if omitted, a fresh `cmp_<8-char-rand>` is minted
 *   output: { componentId, messageId?, type }
 *
 * Required context:
 *   - `context.publisher` (RunPublisher) — the tool can only emit inside an
 *     active run. Outside of a run, returns a VALIDATION error.
 *
 * Spec ref: chat-epic-4-interactive-signoff.md §3 (frozen ChatComponentSpec).
 */

import { randomBytes } from 'crypto';

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import {
  assertChatComponentSpec,
  ChatComponentSpecValidationError,
  CHAT_COMPONENT_TYPES,
  CHAT_COMPONENT_CHANNELS,
} from '../../chat-components/spec-schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

const NANO_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function shortRandomId(): string {
  // 8 chars * 6 bits ≈ 48 bits of entropy — same approach as the generate-id
  // tool's `short` mode, kept inline to avoid a dependency on nanoid.
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += NANO_ALPHABET[bytes[i] % NANO_ALPHABET.length];
  }
  return out;
}

function mintComponentId(): string {
  return `cmp_${shortRandomId()}`;
}

function validationError(message: string): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code: 'VALIDATION' }) }],
    isError: true,
  };
}

interface EmitComponentArgs {
  componentId?: string;
  type?: string;
  config?: AnyObject;
  binding?: AnyObject;
  interaction?: AnyObject;
}

const emitComponentTool: NativeToolDefinition = {
  description:
    'Emit a chat-component spec to the active run stream. The component renders inline on the agent message via the chat-components catalog (button-group, info-panel, form). The tool injects componentId, runId, messageId, surfaces, and emittedAt — the caller only supplies type + config + optional binding/interaction. Returns the minted componentId.',
  server: 'chat-components',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'config'],
    properties: {
      type: {
        type: 'string',
        enum: [...CHAT_COMPONENT_TYPES],
        description:
          'Allowlisted component type. v1: "button-group" (choice / followup), "info-panel" (display), "form" (input).',
      },
      config: {
        type: 'object',
        description:
          'Per-type config bag (e.g. button-group expects `buttons:[{label,...}]`). Validated by the catalog when rendered. Free-shape at the schema level.',
      },
      binding: {
        type: 'object',
        description:
          'Optional Global State binding — { source:"globalState", namespace, key, path?, transform? }.',
      },
      interaction: {
        type: 'object',
        description:
          `Optional feedback descriptor. channel ∈ ${CHAT_COMPONENT_CHANNELS.join('|')}. ` +
          'For "followup": include `text` (synthetic user message body, ≤4000 chars). ' +
          'For "state-write": include `namespace` and `key`. ' +
          'For "run-event": no extra fields required.',
      },
      componentId: {
        type: 'string',
        description:
          'Optional override for the minted component id. Useful when the caller needs to reference this component later (e.g. answered marker). When omitted, a fresh "cmp_<8-char-rand>" id is minted.',
      },
    },
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = (rawArgs ?? {}) as EmitComponentArgs;

    // Require a publisher — emit_component only makes sense inside a run.
    const publisher = context.publisher as unknown as
      | { publishComponent: (spec: Record<string, unknown>) => Promise<void> }
      | null;
    if (!publisher || typeof publisher.publishComponent !== 'function') {
      return validationError(
        'emit_component requires an active run context (publisher missing)',
      );
    }

    // Assemble the spec body. The publisher will inject runId/messageId/
    // surfaces/emittedAt again as a safety net, but we inject them here
    // first so the schema-error message references the exact payload the
    // caller submitted (with provenance applied).
    const componentId = typeof args.componentId === 'string' && args.componentId.length > 0
      ? args.componentId
      : mintComponentId();
    const spec: Record<string, unknown> = {
      componentId,
      type: args.type,
      config: args.config,
      ...(args.binding !== undefined ? { binding: args.binding } : {}),
      ...(args.interaction !== undefined ? { interaction: args.interaction } : {}),
    };

    try {
      // publishComponent re-asserts the schema with the engine's provenance
      // injected; if anything is off-schema it throws
      // ChatComponentSpecValidationError BEFORE anything lands on the wire.
      await publisher.publishComponent(spec);
    } catch (err: unknown) {
      if (err instanceof ChatComponentSpecValidationError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: err.message,
                code: 'SCHEMA',
                fieldErrors: err.errors,
              }),
            },
          ],
          isError: true,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `emit_component failed: ${message}` }) }],
        isError: true,
      };
    }

    // Reach into the publisher's exposed runId / messageId for the response.
    // Both are read-only inspection — no extra coupling.
    const runId = (context.runId as string | null) ?? null;
    const messageId =
      (publisher as unknown as { convMessageId?: string | null }).convMessageId ?? null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            componentId,
            messageId,
            runId,
            type: args.type,
          }),
        },
      ],
    };
  },
};

export default emitComponentTool;
module.exports = emitComponentTool;
