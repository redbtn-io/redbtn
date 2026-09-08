/**
 * neuronExecutor — Anthropic prompt caching, end to end through the executor.
 *
 * The unit tests in `tests/neurons/prompt-cache.test.ts` pin the helpers. These
 * pin the WIRING, which is where this feature can silently do nothing: the
 * markers have to survive the executor's own `normalizeMessages()` pass (it
 * flattens a marked system block array straight back to a string), and they
 * must never reach a non-Anthropic provider.
 *
 * Also pinned: the cache split now lands on the redToken usage sample, so the
 * run archive and a later rate card can see what was served from cache instead
 * of inferring it from a single fused input number.
 */
import { describe, expect, it, vi } from 'vitest';
import { executeNeuron } from '../../src/lib/nodes/universal/executors/neuronExecutor';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface Harness {
  state: Any;
  calls: Array<{ messages: Any[]; options: Any }>;
  samples: Any[];
}

/**
 * Executor harness. The plain (non-structured) path always goes through
 * `callNeuron(stream: true)` internally, even when the step doesn't stream to
 * the user, so the fake yields one usage-bearing chunk.
 */
function makeHarness(neuronConfig: Any, over: Any = {}): Harness {
  const calls: Array<{ messages: Any[]; options: Any }> = [];
  const samples: Any[] = [];

  async function* chunks() {
    yield {
      content: 'ok',
      usage_metadata: {
        input_tokens: 3148,
        output_tokens: 4,
        total_tokens: 3152,
        input_token_details: { cache_creation: 146, cache_read: 3000 },
      },
    };
  }

  const neuronRegistry = {
    getConfig: vi.fn(async () => neuronConfig),
    getModel: vi.fn(async () => ({ bindTools: vi.fn() })),
    callNeuron: vi.fn(async (_id: Any, _userId: Any, messages: Any, options: Any) => {
      calls.push({ messages, options });
      return options?.stream ? chunks() : { content: 'ok' };
    }),
  };

  return {
    calls,
    samples,
    state: {
      neuronRegistry,
      meteringClient: {
        neuron: {
          recordNeuronCall: vi.fn((input: Any) => {
            const sample = { model: input.model, inputTokens: 3148, outputTokens: 4 };
            samples.push(sample);
            return { sample, usage: {}, envelope: {} };
          }),
        },
      },
      data: { runId: 'run_cache_test' },
      parameters: {},
      ...over,
    } as Any,
  };
}

const baseConfig = {
  neuronId: 'test-neuron',
  userPrompt: 'hello',
  systemPrompt: 'You are Red, a careful assistant.',
  outputField: 'data.out',
  stream: false,
};

/** Let the fire-and-forget metering emit settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('neuronExecutor — Anthropic prompt cache breakpoints', () => {
  it('marks the system prompt with cache_control for an anthropic neuron', async () => {
    const h = makeHarness({ provider: 'anthropic', model: 'claude-opus-5' });

    await executeNeuron(baseConfig as Any, h.state);

    const system = h.calls[0].messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toEqual([
      {
        type: 'text',
        text: 'You are Red, a careful assistant.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('survives the streaming path\'s own normalizeMessages() pass', async () => {
    // normalizeMessages() flattens block arrays back to a string. If the marker
    // were applied before that pass instead of after it, this would be a string.
    const h = makeHarness({ provider: 'anthropic', model: 'claude-sonnet-5' });

    await executeNeuron({ ...baseConfig, stream: true } as Any, h.state);

    expect(Array.isArray(h.calls[0].messages[0].content)).toBe(true);
  });

  it('leaves every other provider with a plain string system prompt', async () => {
    for (const cfg of [
      { provider: 'google', model: 'gemini-2.5-flash' },
      { provider: 'openai', model: 'gpt-5' },
      { provider: 'ollama', model: 'llama3.1:70b' },
      { provider: 'anthropic', model: 'some-custom-endpoint-model' },
    ]) {
      const h = makeHarness(cfg);
      await executeNeuron(baseConfig as Any, h.state);

      const system = h.calls[0].messages[0];
      expect(system.content, `${cfg.provider}/${cfg.model}`).toBe(
        'You are Red, a careful assistant.',
      );
      expect(h.calls[0].options.invokeOptions?.cache_control).toBeUndefined();
    }
  });

  it('adds no history breakpoint to a single-shot [system, user] call', async () => {
    const h = makeHarness({ provider: 'anthropic', model: 'claude-opus-5' });

    await executeNeuron(baseConfig as Any, h.state);

    expect(h.calls[0].messages).toHaveLength(2);
    expect(h.calls[0].options.invokeOptions?.cache_control).toBeUndefined();
  });

  it('adds a history breakpoint once there is a conversation to re-read', async () => {
    const h = makeHarness(
      { provider: 'anthropic', model: 'claude-opus-5' },
      {
        data: {
          runId: 'run_cache_test',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'answer' },
            { role: 'user', content: 'second' },
          ],
        },
      },
    );

    await executeNeuron(
      { ...baseConfig, userPrompt: '{{state.data.messages}}' } as Any,
      h.state,
    );

    expect(h.calls[0].messages.length).toBeGreaterThan(2);
    expect(h.calls[0].options.invokeOptions?.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('neuronExecutor — prompt cache across a fallback hop (#404 interaction)', () => {
  it('re-evaluates the provider gate on the fallback neuron, not the primary\'s', async () => {
    // Gemini primary rate-limits, an Anthropic neuron answers. The gate is
    // computed inside executeNeuronInternal from the neuron config of the
    // attempt that is actually running, so the marker must appear only on the
    // second call — not carried over, and not suppressed by the first.
    const byId: Any = {
      'gemini-primary': { provider: 'google', model: 'gemini-2.5-flash' },
      'claude-backup': { provider: 'anthropic', model: 'claude-opus-5' },
    };
    const h = makeHarness(byId['gemini-primary']);
    h.state.neuronRegistry.getConfig = vi.fn(async (id: string) => byId[id]);
    h.state.neuronRegistry.callNeuron = vi.fn(async (id: Any, _u: Any, m: Any, o: Any) => {
      h.calls.push({ messages: m, options: o });
      if (id === 'gemini-primary') {
        throw new Error('429 Too Many Requests — quota exceeded');
      }
      return (async function* () {
        yield { content: 'ok' };
      })();
    });

    await executeNeuron(
      { ...baseConfig, neuronId: 'gemini-primary', fallbackNeuronId: 'claude-backup' } as Any,
      h.state,
    );

    expect(h.calls).toHaveLength(2);
    // Primary (google): plain string system prompt.
    expect(h.calls[0].messages[0].content).toBe('You are Red, a careful assistant.');
    // Fallback (anthropic): marked block array.
    expect(h.calls[1].messages[0].content).toEqual([
      {
        type: 'text',
        text: 'You are Red, a careful assistant.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });
});

describe('neuronExecutor — cache usage accounting', () => {
  it('surfaces the cache split on the usage sample alongside inputTokens', async () => {
    const h = makeHarness({ provider: 'anthropic', model: 'claude-opus-5' });

    await executeNeuron(baseConfig as Any, h.state);
    await flush();

    expect(h.samples).toHaveLength(1);
    const sample = h.samples[0];
    // Additive: the Rater's fields keep their meaning and their values.
    expect(sample.inputTokens).toBe(3148);
    expect(sample.outputTokens).toBe(4);
    // New, priceable separately.
    expect(sample.cacheCreationInputTokens).toBe(146);
    expect(sample.cacheReadInputTokens).toBe(3000);
    expect(sample.uncachedInputTokens).toBe(2);
  });

  it('leaves the sample untouched when the provider reported no cache', async () => {
    const h = makeHarness({ provider: 'google', model: 'gemini-2.5-flash' });
    // Re-point the stream at a usage payload with no cache counters.
    h.state.neuronRegistry.callNeuron = vi.fn(async (_i: Any, _u: Any, m: Any, o: Any) => {
      h.calls.push({ messages: m, options: o });
      return (async function* () {
        yield { content: 'ok', usage_metadata: { input_tokens: 10, output_tokens: 2 } };
      })();
    });

    await executeNeuron(baseConfig as Any, h.state);
    await flush();

    expect(h.samples).toHaveLength(1);
    expect(h.samples[0].cacheReadInputTokens).toBeUndefined();
    expect(h.samples[0].uncachedInputTokens).toBeUndefined();
  });
});
