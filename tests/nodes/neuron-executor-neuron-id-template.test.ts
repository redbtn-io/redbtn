/**
 * neuronExecutor — `neuronId` template resolution.
 *
 * # What was broken
 *
 * Every other templated field on a neuron step (temperature, maxTokens) went
 * through `resolveConfigValue`. `neuronId` did not — it was read straight off
 * the config:
 *
 *     const neuronId = config.neuronId || state.defaultNeuronId || ...
 *
 * So a node authored the obvious, reusable way —
 * `neuronId: "{{parameters.triageNeuronId}}"` — passed that literal string to
 * the registry, the lookup missed, and the step threw. Steps that carry an
 * `errorHandling.onError: 'fallback'` (the norm for optional LLM steps) then
 * swallowed the throw, so the node looked healthy while its neuron never ran.
 * That is exactly how it surfaced: the Red Ops triage gate would have fallen
 * open on every ambiguous tick and silently saved nothing.
 *
 * These tests pin the fix and the non-regression: a literal id still works, a
 * templated id resolves against parameters/state, and an unresolvable template
 * falls back to the state default instead of being used as a garbage id.
 */
import { describe, expect, it, vi } from 'vitest';
import { executeNeuron } from '../../src/lib/nodes/universal/executors/neuronExecutor';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * Minimal registry that records which neuron id the executor asked for.
 * `callNeuron` returns an async-iterable when the executor streams, which is
 * the path a non-streaming step still takes internally.
 */
function makeState(over: Any = {}) {
  const asked: string[] = [];
  async function* chunks() {
    yield { content: 'ok' };
  }
  const neuronRegistry = {
    getConfig: vi.fn(async (id: string) => ({ neuronId: id, model: 'gemini-2.5-flash' })),
    getModel: vi.fn(async (id: string) => {
      asked.push(id);
      return {};
    }),
    callNeuron: vi.fn(async (id: string, _userId: Any, _messages: Any, opts: Any) => {
      asked.push(id);
      return opts?.stream ? chunks() : { content: 'ok' };
    }),
  };
  return {
    asked,
    state: {
      neuronRegistry,
      data: { runId: 'run_test' },
      parameters: {},
      ...over,
    } as Any,
  };
}

const baseConfig = {
  userPrompt: 'hello',
  outputField: 'data.out',
  stream: false,
};

describe('neuronExecutor — neuronId resolution', () => {
  it('resolves a {{parameters.x}} neuronId against the node parameters', async () => {
    const { state, asked } = makeState({ parameters: { triageNeuronId: 'become-gemma' } });

    await executeNeuron({ ...baseConfig, neuronId: '{{parameters.triageNeuronId}}' } as Any, state);

    expect(asked).toContain('become-gemma');
    expect(asked).not.toContain('{{parameters.triageNeuronId}}');
  });

  it('still passes a literal neuronId straight through (no regression)', async () => {
    const { state, asked } = makeState();

    await executeNeuron({ ...baseConfig, neuronId: 'become-gemma' } as Any, state);

    expect(asked).toContain('become-gemma');
  });

  it('resolves a {{state.data.x}} neuronId', async () => {
    const { state, asked } = makeState({ data: { runId: 'r', chosenNeuron: 'become-gemma' } });

    await executeNeuron({ ...baseConfig, neuronId: '{{state.data.chosenNeuron}}' } as Any, state);

    expect(asked).toContain('become-gemma');
  });

  it('falls back to the state default when the template resolves to nothing', async () => {
    const { state, asked } = makeState({ parameters: {}, defaultNeuronId: 'fallback-neuron' });

    await executeNeuron({ ...baseConfig, neuronId: '{{parameters.missing}}' } as Any, state);

    expect(asked).toContain('fallback-neuron');
    expect(asked).not.toContain('{{parameters.missing}}');
  });

  it('throws when neither the template nor a default resolves', async () => {
    const { state } = makeState({ parameters: {} });

    await expect(
      executeNeuron({ ...baseConfig, neuronId: '{{parameters.missing}}' } as Any, state),
    ).rejects.toThrow(/No neuron available/);
  });
});
