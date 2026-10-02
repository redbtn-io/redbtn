/**
 * Anthropic prompt caching — deliberate cache breakpoints + usage accounting.
 *
 * # Why
 *
 * Anthropic prompt caching is a PREFIX match. The request is serialised as
 * `tools` -> `system` -> `messages`, a `cache_control` marker caches everything
 * up to and including the block it sits on, and a cache read costs ~0.1x of a
 * fresh input token (a write costs ~1.25x). Before this module the engine set
 * no `cache_control` anywhere, so every Anthropic turn re-paid full price for
 * the tool schemas and the system prompt it had already sent a second earlier.
 *
 * Two breakpoints are placed by default:
 *
 *   1. the LAST client tool definition — caches the whole tool block, which is
 *      byte-identical for every call of a given node;
 *   2. the system prompt block — caches tools + system together, so a node
 *      whose tool list is stable still gets a hit when only the system text
 *      moves.
 *
 * A third, optional breakpoint (`cache_control` as a call option, applied by
 * `@langchain/anthropic` to the last content block of the last message) caches
 * the conversation prefix. It is only worth a cache WRITE when there is real
 * history to re-read on the next turn, so it is gated on
 * `shouldCacheHistoryPrefix()` — the tool-use loop and multi-turn chat.
 * Anthropic allows at most 4 breakpoints per request; we use at most 3.
 *
 * # The prefix must be byte-stable
 *
 * A cache breakpoint on volatile text is worse than no breakpoint: it pays the
 * 1.25x write on every call and never reads. Anything interpolated into the
 * system prompt that changes between runs (a clock at minute precision, a run
 * id, a state snapshot) destroys the hit rate for everything after it. The
 * engine's own contribution to that was `getNodeSystemPrefix()`, which is
 * prepended to EVERY neuron system prompt — it is now day-precision for
 * exactly this reason (see `src/lib/utils/node-helpers.ts`); graphs that need
 * the wall clock have the native `now` tool.
 *
 * # Support
 *
 * Breakpoints are Anthropic only. OpenAI-compatible endpoints cache repeated
 * prefixes implicitly but need a `prompt_cache_key` so the turns of one
 * conversation land on the replica that holds the cache (see the bottom of this
 * file). Gemini caches implicitly. `extractCacheUsage()` reports every
 * provider's cached-token counters so the same accounting works for all.
 */

import { createHash } from 'node:crypto';

/** The only cache type Anthropic exposes today (5-minute TTL). */
export const EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' as const };

export type CacheControl = typeof EPHEMERAL_CACHE_CONTROL;

/**
 * Does this neuron's provider/model pair support explicit `cache_control`?
 *
 * Anthropic only, and only for Claude models — a `provider: 'anthropic'`
 * neuron can be pointed at a custom `endpoint` running something else
 * entirely, and Ollama/custom/OpenAI/Gemini must never receive the marker.
 *
 * Every Claude model from 3.x onward supports prompt caching; the one
 * exception is the retired `claude-3-sonnet`, which never did. Model ids are
 * matched loosely so gateway prefixes (`anthropic.claude-…`, `us.anthropic.…`)
 * still resolve.
 */
export function supportsPromptCache(provider?: string, model?: string): boolean {
  if (provider !== 'anthropic') return false;
  if (typeof model !== 'string') return false;
  const idx = model.toLowerCase().indexOf('claude-');
  if (idx === -1) return false;
  const id = model.toLowerCase().slice(idx);
  if (id.startsWith('claude-3-sonnet')) return false;
  return true;
}

/**
 * Mark the system prompt with a cache breakpoint.
 *
 * The engine builds messages as plain `{ role, content }` objects and
 * `normalizeMessages()` collapses every system message into a single
 * string-content entry at index 0. Anthropic accepts `system` as either a
 * string or an array of text blocks, and `@langchain/anthropic` forwards
 * `messages[0].content` verbatim when it is the system message — so promoting
 * that string to a one-element block array is all that is needed.
 *
 * Deliberately conservative: anything that is not a plain string-content
 * system object at index 0 (a LangChain `SystemMessage` instance, an already
 * marked block array, no system message at all) is returned untouched. Pure —
 * the input array is never mutated.
 *
 * NOTE for callers: `normalizeMessages()` flattens block arrays back to a
 * string, so this must be applied AFTER the last normalization pass, i.e.
 * immediately before the provider call.
 */
export function applySystemCacheControl<T>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const first = messages[0] as any;
  if (!first || typeof first !== 'object') return messages;
  // A LangChain message instance — leave it alone rather than guess at its
  // internal shape.
  if (typeof first._getType === 'function') return messages;
  if (first.role !== 'system') return messages;

  const content = first.content;
  if (typeof content === 'string') {
    if (content.length === 0) return messages;
    const marked = {
      ...first,
      content: [{ type: 'text', text: content, cache_control: EPHEMERAL_CACHE_CONTROL }],
    };
    return [marked, ...messages.slice(1)] as T[];
  }

  if (Array.isArray(content) && content.length > 0) {
    // Already marked somewhere in the block array — nothing to do.
    if (content.some((block: any) => block && typeof block === 'object' && block.cache_control)) {
      return messages;
    }
    const blocks = content.slice();
    const last = blocks[blocks.length - 1];
    if (!last || typeof last !== 'object') return messages;
    blocks[blocks.length - 1] = { ...last, cache_control: EPHEMERAL_CACHE_CONTROL };
    return [{ ...first, content: blocks }, ...messages.slice(1)] as T[];
  }

  return messages;
}

/**
 * Mark the last client tool definition with a cache breakpoint.
 *
 * `toBindToolsPayload()` emits `{ name, description, schema }`, which
 * `@langchain/anthropic` maps to an Anthropic tool. An object that already
 * carries `input_schema` is recognised as a native Anthropic tool and passed
 * through VERBATIM (`isAnthropicTool` is checked before `isLangChainTool`),
 * which is how `cache_control` survives the conversion — so the marked entry
 * is rewritten into that native shape.
 *
 * Provider-hosted specs (`hosted:web_search` and friends) are left alone: they
 * are server tools whose wire shape belongs to the provider. When the tail of
 * the list is hosted, the marker moves to the last CLIENT tool before them —
 * a breakpoint earlier in the block still caches everything ahead of it, and
 * the system breakpoint covers the rest.
 *
 * Pure; returns the input untouched when there is nothing markable.
 */
export function applyToolCacheControl<T>(tools: T[]): T[] {
  if (!Array.isArray(tools) || tools.length === 0) return tools;

  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i] as any;
    if (!tool || typeof tool !== 'object') continue;

    // Native Anthropic shape already — just add the marker.
    if (tool.input_schema && typeof tool.input_schema === 'object') {
      if (tool.cache_control) return tools;
      const out = tools.slice();
      out[i] = { ...tool, cache_control: EPHEMERAL_CACHE_CONTROL } as T;
      return out;
    }

    // The engine's own client-tool payload.
    if (typeof tool.name === 'string' && tool.schema && typeof tool.schema === 'object') {
      const out = tools.slice();
      out[i] = {
        name: tool.name,
        description: tool.description,
        input_schema: tool.schema,
        cache_control: EPHEMERAL_CACHE_CONTROL,
      } as T;
      return out;
    }
    // Anything else (a hosted/provider spec) — keep looking backwards.
  }

  return tools;
}

/**
 * Is there enough conversation history to be worth a breakpoint on the last
 * message?
 *
 * The marker costs a cache write on this turn and only pays off if a later
 * turn re-sends this prefix. A bare `[system, user]` single-shot call never
 * does; a tool-use loop iteration or a chat with history always does.
 */
export function shouldCacheHistoryPrefix(messages: unknown[]): boolean {
  return Array.isArray(messages) && messages.length > 2;
}

/**
 * Call options to merge into `model.invoke()` / `model.stream()` for the
 * history-prefix breakpoint. `@langchain/anthropic` reads `cache_control` off
 * the call options and applies it to the last content block of the last
 * message (`applyCacheControlToPayload`), on both the streaming and the
 * non-streaming path.
 */
export function historyCacheInvokeOptions(): Record<string, unknown> {
  return { cache_control: EPHEMERAL_CACHE_CONTROL };
}

/** The cache split of one provider response, in engine-canonical names. */
export interface CacheUsage {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Pull the cache split out of a provider response, whatever shape it arrived
 * in. Returns null when the response carries no cache counters at all (every
 * non-Anthropic provider before a cache hit, and Ollama always), so callers
 * can leave the usage sample untouched rather than writing zeroes.
 *
 * Recognised shapes:
 *  - LangChain unified: `usage_metadata.input_token_details.{cache_creation,cache_read}`
 *    (what `ChatAnthropic` emits, and what `claudeCodeExecutor` now synthesises)
 *  - Anthropic raw:     `usage.{cache_creation_input_tokens,cache_read_input_tokens}`
 *  - OpenAI:            `usage.prompt_tokens_details.cached_tokens` (implicit
 *                        caching — reads only, OpenAI never charges a write)
 *  - Google Gemini:     `usageMetadata.cachedContentTokenCount` (ditto)
 *
 * IMPORTANT: on every one of these providers the headline input-token number
 * (`usage_metadata.input_tokens`) ALREADY INCLUDES the cached tokens. This is
 * a breakdown of that number, never an addition to it.
 */
export function extractCacheUsage(response: unknown): CacheUsage | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as any;

  const details = r.usage_metadata?.input_token_details;
  if (details && typeof details === 'object') {
    const created = num(details.cache_creation);
    const read = num(details.cache_read);
    if (created > 0 || read > 0) {
      return { cacheCreationInputTokens: created, cacheReadInputTokens: read };
    }
    return null;
  }

  const usage = r.usage;
  if (usage && typeof usage === 'object') {
    const created = num(usage.cache_creation_input_tokens);
    const read =
      num(usage.cache_read_input_tokens) || num(usage.prompt_tokens_details?.cached_tokens);
    if (created > 0 || read > 0) {
      return { cacheCreationInputTokens: created, cacheReadInputTokens: read };
    }
  }

  const gemini = num(r.usageMetadata?.cachedContentTokenCount);
  if (gemini > 0) {
    return { cacheCreationInputTokens: 0, cacheReadInputTokens: gemini };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache affinity for OpenAI-compatible endpoints (`prompt_cache_key`)
// ─────────────────────────────────────────────────────────────────────────────
//
// OpenAI-style "implicit" caching has no markers, but it is still per machine:
// the provider keeps the KV cache of a prompt on the replica that served it,
// and a later request only reads it if it lands on that same replica.
// `prompt_cache_key` is the routing hint that makes that happen — requests that
// share a key are sent to the same backend.
//
// Without it the hit rate collapses on any provider that load-balances across
// many replicas. Measured 2026-10-02 against `meta/muse-spark-1.3-contributor`
// on OpenRouter (single provider "Meta"), six identical ~6.9k-token requests:
//
//   no key                    113, 113, 113, 113, 113, 113  cached tokens
//   user / session_id only    mostly 113, one partial hit
//   prompt_cache_key          3825, 6769, 6769, 6769, 6769, 6769
//
// (113 is a tool-preamble the provider caches globally.) The engine's native
// tool loop re-sends a strictly growing, append-only transcript, so every turn
// is a perfect prefix of the next one; all it was missing was the key. On
// OpenRouter the same field doubles as the provider sticky-routing key when no
// `session_id` is sent, so this one field covers both layers.

/**
 * Should this neuron's calls carry a `prompt_cache_key`?
 *
 * `openai` neurons talk to api.openai.com or an OpenAI-compatible gateway
 * (OpenRouter is the one in use); both honour the field. Other providers that
 * reuse `ChatOpenAI` (`custom`, the zen family) point at arbitrary servers that
 * may reject an unknown body field, so they only get it when the endpoint is
 * OpenRouter itself. Anthropic/Google/Ollama never do — they have their own
 * mechanisms (or none).
 */
export function supportsPromptCacheKey(provider?: string, endpoint?: string): boolean {
  if (provider === 'openai') return true;
  if (provider === 'custom' || provider === 'opencode-zen' || provider === 'zen') {
    return isOpenRouterEndpoint(endpoint);
  }
  return false;
}

function isOpenRouterEndpoint(endpoint?: string): boolean {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return false;
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

function messageRole(m: any): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  if (typeof m.role === 'string') return m.role;
  if (typeof m._getType === 'function') {
    const t = m._getType();
    return t === 'human' ? 'user' : t === 'ai' ? 'assistant' : t;
  }
  return undefined;
}

function contentText(m: any): string {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part: any) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

/**
 * Derive the `prompt_cache_key` for a conversation.
 *
 * The key must be identical on every turn of one conversation and different
 * between unrelated conversations (one key for everything would pin all traffic
 * to one replica and overflow it). Hashing the OPENING of the conversation —
 * the first system message and the first non-system message, plus the neuron —
 * gives exactly that without any plumbing: the tool loop and multi-turn chat
 * only ever append, so the opening never changes, and two runs that open with
 * the same text (a retry of the same card) share the key and the cache. This is
 * also how OpenRouter identifies a conversation for sticky routing.
 *
 * Returns undefined when there is nothing to key on. Pure.
 */
export function derivePromptCacheKey(scope: string, messages: unknown[]): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const firstSystem = messages.find((m) => {
    const r = messageRole(m);
    return r === 'system' || r === 'developer';
  });
  const firstOther = messages.find((m) => {
    const r = messageRole(m);
    return r !== undefined && r !== 'system' && r !== 'developer';
  });
  const opening = `${contentText(firstSystem)}\u0000${contentText(firstOther)}`;
  if (opening === '\u0000') return undefined;
  const digest = createHash('sha256').update(`${scope}\u0000${opening}`).digest('hex').slice(0, 32);
  return `rb-${digest}`;
}

/**
 * Call options carrying the affinity key. `@langchain/openai` reads
 * `promptCacheKey` off the call options and sends it as `prompt_cache_key`.
 */
export function promptCacheKeyInvokeOptions(key: string | undefined): Record<string, unknown> | undefined {
  return key ? { promptCacheKey: key } : undefined;
}
