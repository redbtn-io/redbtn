/**
 * Anthropic prompt caching — breakpoint placement, provider gating, usage split
 * and the byte-stability rule the whole thing rests on.
 *
 * # What this pins
 *
 * The engine set no `cache_control` anywhere, so every Anthropic turn re-paid
 * full input price for the tool schemas and the system prompt it had just
 * sent. `prompt-cache.ts` places the markers; these tests pin (a) that they
 * land on the right block, (b) that they land ONLY on Anthropic — an Ollama or
 * Gemini neuron receiving an Anthropic-shaped content block would break the
 * call, not just cost more — and (c) that the cached prefix is byte-stable
 * across renders, which is the property that makes a breakpoint pay at all.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  EPHEMERAL_CACHE_CONTROL,
  supportsPromptCache,
  applySystemCacheControl,
  applyToolCacheControl,
  shouldCacheHistoryPrefix,
  historyCacheInvokeOptions,
  extractCacheUsage,
} from '../../src/lib/neurons/prompt-cache';
import { getNodeSystemPrefix } from '../../src/lib/utils/node-helpers';
import { renderTemplate } from '../../src/lib/nodes/universal/templateRenderer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('supportsPromptCache — provider/model gate', () => {
  it('accepts current Claude models on the anthropic provider', () => {
    for (const model of [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-3-5-sonnet-20241022',
      'claude-3-7-sonnet-latest',
      'anthropic.claude-opus-4-8',
      'us.anthropic.claude-sonnet-4-6',
    ]) {
      expect(supportsPromptCache('anthropic', model), model).toBe(true);
    }
  });

  it('rejects every other provider — an Anthropic content block would break them', () => {
    for (const provider of ['openai', 'google', 'ollama', 'custom', 'claude-code', undefined]) {
      expect(supportsPromptCache(provider as Any, 'claude-opus-5'), String(provider)).toBe(false);
    }
  });

  it('rejects a non-Claude model behind the anthropic provider (custom endpoint)', () => {
    expect(supportsPromptCache('anthropic', 'llama3.1:70b')).toBe(false);
    expect(supportsPromptCache('anthropic', undefined)).toBe(false);
  });

  it('rejects claude-3-sonnet, the one Claude that never supported caching', () => {
    expect(supportsPromptCache('anthropic', 'claude-3-sonnet-20240229')).toBe(false);
  });
});

describe('applySystemCacheControl', () => {
  it('promotes a string system prompt to a marked text block', () => {
    const messages = [
      { role: 'system', content: 'You are Red.' },
      { role: 'user', content: 'hi' },
    ];

    const out = applySystemCacheControl(messages);

    expect(out[0]).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: 'You are Red.', cache_control: { type: 'ephemeral' } },
      ],
    });
    // Every other message is untouched, and the input is not mutated.
    expect(out[1]).toBe(messages[1]);
    expect(messages[0].content).toBe('You are Red.');
  });

  it('is a no-op when there is no system message', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    expect(applySystemCacheControl(messages)).toBe(messages);
  });

  it('is idempotent — a second pass does not add a second breakpoint', () => {
    const once = applySystemCacheControl([{ role: 'system', content: 'S' }]);
    const twice = applySystemCacheControl(once);
    expect(twice).toBe(once);
    expect((twice[0] as Any).content).toHaveLength(1);
  });

  it('leaves a LangChain message instance alone rather than guessing its shape', () => {
    const messages = [{ role: 'system', content: 'S', _getType: () => 'system' }];
    expect(applySystemCacheControl(messages)).toBe(messages);
  });

  it('ignores an empty system prompt (nothing to cache)', () => {
    const messages = [{ role: 'system', content: '' }, { role: 'user', content: 'hi' }];
    expect(applySystemCacheControl(messages)).toBe(messages);
  });
});

describe('applyToolCacheControl', () => {
  const clientTool = (name: string) => ({
    name,
    description: `the ${name} tool`,
    schema: { type: 'object', properties: {} },
  });

  it('rewrites the last client tool into the native Anthropic shape with the marker', () => {
    const tools = [clientTool('a'), clientTool('b')];

    const out = applyToolCacheControl(tools) as Any[];

    expect(out[0]).toBe(tools[0]);
    expect(out[1]).toEqual({
      name: 'b',
      description: 'the b tool',
      input_schema: { type: 'object', properties: {} },
      cache_control: { type: 'ephemeral' },
    });
  });

  it('skips provider-hosted specs and marks the last client tool before them', () => {
    const hosted = { type: 'web_search_20250305', name: 'web_search' };
    const tools = [clientTool('a'), hosted];

    const out = applyToolCacheControl(tools) as Any[];

    expect(out[1]).toBe(hosted);
    expect(out[0].cache_control).toEqual(EPHEMERAL_CACHE_CONTROL);
    expect(out[0].input_schema).toBeDefined();
  });

  it('returns hosted-only and empty lists untouched', () => {
    const hostedOnly = [{ type: 'web_search_20250305', name: 'web_search' }];
    expect(applyToolCacheControl(hostedOnly)).toBe(hostedOnly);
    const empty: unknown[] = [];
    expect(applyToolCacheControl(empty)).toBe(empty);
  });

  it('does not double-mark an already-native tool', () => {
    const tools = [{ name: 'a', input_schema: {}, cache_control: EPHEMERAL_CACHE_CONTROL }];
    expect(applyToolCacheControl(tools)).toBe(tools);
  });
});

describe('shouldCacheHistoryPrefix', () => {
  it('declines a single-shot [system, user] call — the write would never be read', () => {
    expect(shouldCacheHistoryPrefix([{ role: 'system' }, { role: 'user' }])).toBe(false);
  });

  it('accepts a conversation with history', () => {
    expect(
      shouldCacheHistoryPrefix([{ role: 'system' }, { role: 'user' }, { role: 'assistant' }, { role: 'user' }]),
    ).toBe(true);
  });

  it('carries the marker as a LangChain call option', () => {
    expect(historyCacheInvokeOptions()).toEqual({ cache_control: { type: 'ephemeral' } });
  });
});

describe('extractCacheUsage — one reader for every provider shape', () => {
  it('reads the LangChain unified shape (ChatAnthropic + the claude-code executor)', () => {
    expect(
      extractCacheUsage({
        usage_metadata: {
          input_tokens: 3148,
          output_tokens: 4,
          input_token_details: { cache_creation: 3146, cache_read: 0 },
        },
      }),
    ).toEqual({ cacheCreationInputTokens: 3146, cacheReadInputTokens: 0 });
  });

  it('reads raw Anthropic usage', () => {
    expect(
      extractCacheUsage({
        usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 3146 },
      }),
    ).toEqual({ cacheCreationInputTokens: 0, cacheReadInputTokens: 3146 });
  });

  it("reads OpenAI's implicit cache (reads only — OpenAI never charges a write)", () => {
    expect(
      extractCacheUsage({ usage: { prompt_tokens: 900, prompt_tokens_details: { cached_tokens: 768 } } }),
    ).toEqual({ cacheCreationInputTokens: 0, cacheReadInputTokens: 768 });
  });

  it("reads Gemini's implicit cache", () => {
    expect(extractCacheUsage({ usageMetadata: { cachedContentTokenCount: 512 } })).toEqual({
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 512,
    });
  });

  it('returns null when nothing cached, so callers leave the sample alone', () => {
    expect(extractCacheUsage({ usage_metadata: { input_tokens: 10, output_tokens: 2 } })).toBeNull();
    expect(extractCacheUsage({ prompt_eval_count: 10, eval_count: 2 })).toBeNull();
    expect(extractCacheUsage(undefined)).toBeNull();
  });
});

// =============================================================================
// Byte stability — the property the whole feature rests on
// =============================================================================

describe('rendered system prompt is byte-stable across renders', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The node prefix + node systemPrompt, assembled the way neuronExecutor does. */
  function renderSystemPrompt(state: Any, systemPrompt: string): string {
    const rendered = renderTemplate(systemPrompt, state);
    return state.systemPrefix ? `${state.systemPrefix}\n\n${rendered}` : rendered;
  }

  const FIXTURE_STATE = {
    data: {
      runId: 'run_2f0c1f84',
      conversationId: 'conv_9911',
      userName: 'George',
      workspace: 'redbtn',
    },
    parameters: { tone: 'terse' },
  };
  const FIXTURE_PROMPT =
    'You are Red, working for {{state.data.userName}} in the {{state.data.workspace}} workspace. Tone: {{parameters.tone}}.';

  it('two consecutive renders of the same node/state produce identical system prompts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:03:12.000Z'));

    const first = renderSystemPrompt(
      { ...FIXTURE_STATE, systemPrefix: getNodeSystemPrefix(1, 'Responder') },
      FIXTURE_PROMPT,
    );

    // Same node, same state, a later turn in the same conversation.
    vi.setSystemTime(new Date('2026-09-08T12:47:59.000Z'));
    const second = renderSystemPrompt(
      { ...FIXTURE_STATE, systemPrefix: getNodeSystemPrefix(1, 'Responder') },
      FIXTURE_PROMPT,
    );

    expect(second).toBe(first);
  });

  it('the node prefix carries no clock finer than a day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:03:12.000Z'));
    const prefix = getNodeSystemPrefix(2, 'Router');

    // The regression that made every Anthropic turn a cache miss: "3:45 PM".
    expect(prefix).not.toMatch(/\d{1,2}:\d{2}/);
    expect(prefix).not.toMatch(/\bAM\b|\bPM\b/);
    expect(prefix).toContain('2nd node');
  });

  it('an hour apart is byte-identical; a day apart is not (the date is still there)', () => {
    vi.useFakeTimers();
    // Midday UTC on both sides so the assertion holds in any local timezone.
    vi.setSystemTime(new Date('2026-09-08T12:00:30.000Z'));
    const early = getNodeSystemPrefix(1, 'Responder');
    vi.setSystemTime(new Date('2026-09-08T12:59:30.000Z'));
    const late = getNodeSystemPrefix(1, 'Responder');
    vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
    const nextDay = getNodeSystemPrefix(1, 'Responder');

    expect(late).toBe(early);
    expect(nextDay).not.toBe(early);
  });
});
