/**
 * Shared conversation-id validator.
 *
 * Incident (2026-10-09): scheduled automation runs have no conversation, so
 * the system `context` node called `get_context_history` with
 * `conversationId: "{{state.data.options.conversationId}}"`, which rendered
 * to JS `undefined`. That id then:
 *   1. reached `buildConversationFilter(undefined)` → `{ conversationId:
 *      undefined }`, which the driver serialises as `null` and matches ANY
 *      `user_conversations` doc lacking that field (access granted to the
 *      wrong doc), and
 *   2. built Redis keys `conversations:undefined:messages`, which held
 *      messages misfiled long ago and injected them into every
 *      conversation-less run.
 *
 * Every path that builds a `conversations:${id}:*` Redis key or a
 * `{ conversationId }` / `{ _id }` Mongo filter MUST gate on
 * {@link isUsableConversationId} first: refuse (throw
 * {@link InvalidConversationIdError} or return a denial / empty success,
 * depending on the caller's contract) instead of querying.
 */

/** Thrown when a conversation id is missing or unusable. Never caught to retry — the caller must not touch storage. */
export class InvalidConversationIdError extends Error {
  readonly code = 'INVALID_CONVERSATION_ID';
  constructor(received: unknown, context?: string) {
    const preview =
      typeof received === 'string'
        ? received.length > 60
          ? `${received.slice(0, 60)}…`
          : received
        : String(received);
    super(
      `Invalid conversationId${context ? ` (${context})` : ''}: ${preview}`,
    );
    this.name = 'InvalidConversationIdError';
  }
}

/** Maximum accepted id length. ObjectIds are 24 chars, `conv_*` ~21, UUIDs 36 — 128 is generous. */
export const MAX_CONVERSATION_ID_LENGTH = 128;

/**
 * Whether `id` is safe to embed in a Redis key or Mongo filter.
 *
 * Rejects: non-strings (`undefined` from unrendered templates, `null`,
 * numbers), empty/whitespace-only strings, the literal strings
 * `"undefined"` / `"null"` / `"NaN"` (a rendered `undefined` that survived
 * as text), anything containing `{{` / `}}` (an unrendered template), and
 * anything with whitespace or over the length limit.
 */
export function isUsableConversationId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_CONVERSATION_ID_LENGTH) return false;
  const lowered = trimmed.toLowerCase();
  if (lowered === 'undefined' || lowered === 'null' || lowered === 'nan') {
    return false;
  }
  if (trimmed.includes('{{') || trimmed.includes('}}')) return false;
  if (/\s/.test(trimmed)) return false;
  return true;
}

/**
 * Throw {@link InvalidConversationIdError} unless `id` is usable.
 * Use at the top of every method that builds `conversations:${id}:*` keys
 * or `{ conversationId }` filters.
 */
export function assertUsableConversationId(
  id: unknown,
  context?: string,
): asserts id is string {
  if (!isUsableConversationId(id)) {
    throw new InvalidConversationIdError(id, context);
  }
}
