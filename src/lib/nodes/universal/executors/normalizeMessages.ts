/**
 * Message-normalization helpers — multimodal-safe.
 *
 * Extracted from neuronExecutor.ts so they can be unit-tested without
 * dragging in the executor's runtime-only require graph (templateRenderer
 * pulls in a hand-maintained dist-only globalState module). Pure, no
 * external dependencies.
 *
 * `mergeMessageContent` and `normalizeMessages` are re-exported from
 * neuronExecutor.ts for callers that import them by the original name.
 */

/**
 * Stringify array-typed content for system-message merging.
 *
 * System messages are conventionally text-only, but the engine accepts
 * `content: string | Array<{ type, text?, ... }>` so a malformed input could
 * arrive here as a parts array. We flatten by concatenating every `text`
 * part's text — non-text parts (image_url, media) are dropped at the system
 * boundary because no provider routes images via the system role.
 */
export function flattenSystemContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
          return (part as { text?: string }).text || '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/**
 * Merge the `content` of two same-role messages, parts-array-safe.
 *
 *   - both strings → `${a}\n\n${b}` (matches pre-multimodal behavior
 *                     byte-for-byte — regression target).
 *   - both arrays  → `[...a, ...b]`. When the join boundary is text-to-text
 *                    we splice a `{ type:'text', text:'\n\n' }` separator
 *                    so the historic double-newline boundary is preserved.
 *   - mixed (string + array OR array + string) → promote the string side to
 *                    a text part and concat, again with a double-newline
 *                    bridge when the join lands between two text parts.
 */
export function mergeMessageContent(a: unknown, b: unknown): string | unknown[] {
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);

  // Pure string path — preserved byte-for-byte for the text-only regression.
  if (!aIsArr && !bIsArr) {
    return `${a}\n\n${b}`;
  }

  const aParts: unknown[] = aIsArr ? (a as unknown[]) : [{ type: 'text', text: String(a ?? '') }];
  const bParts: unknown[] = bIsArr ? (b as unknown[]) : [{ type: 'text', text: String(b ?? '') }];

  const lastOfA = aParts[aParts.length - 1] as { type?: string } | undefined;
  const firstOfB = bParts[0] as { type?: string } | undefined;
  const bridgeText =
    lastOfA?.type === 'text' && firstOfB?.type === 'text'
      ? [{ type: 'text', text: '\n\n' }]
      : [];

  return [...aParts, ...bridgeText, ...bParts];
}

/**
 * Normalize messages to ensure valid LLM conversation format.
 *
 * Issues this fixes:
 * 1. Consecutive same-role messages (user, user) - merges them
 * 2. Multiple system messages - merges all into the first system message
 * 3. System messages not at the start - moves their content to the first system
 *
 * Multimodal-safe: when a message's `content` is an array of parts, the
 * merge concatenates parts arrays instead of string-coercing them (the
 * pre-fix path produced `"[object Object]"` and destroyed image content).
 *
 * Many LLM APIs (including Ollama) hang or error with malformed inputs.
 */
export function normalizeMessages(messages: any[]): any[] {
  if (!messages || messages.length === 0) return messages;

  // First pass: collect all system message content. System messages are
  // text-only by convention; flatten any array-typed content via
  // flattenSystemContent so a multimodal-shaped system message still works.
  let systemContent = '';
  const nonSystemMessages: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const flat = flattenSystemContent(msg.content);
      if (systemContent) {
        systemContent += '\n\n' + flat;
      } else {
        systemContent = flat;
      }
    } else {
      nonSystemMessages.push({ ...msg });
    }
  }

  // Second pass: merge consecutive same-role messages
  const normalized: any[] = [];

  // Add consolidated system message first
  if (systemContent) {
    normalized.push({ role: 'system', content: systemContent });
  }

  // Add non-system messages, merging consecutive same roles
  for (const msg of nonSystemMessages) {
    const lastMsg = normalized[normalized.length - 1];
    if (lastMsg && lastMsg.role === msg.role) {
      lastMsg.content = mergeMessageContent(lastMsg.content, msg.content);
    } else {
      normalized.push({ ...msg });
    }
  }

  return normalized;
}
