/**
 * `agy-cli` provider plumbing.
 *
 * Adding `'agy-cli'` as a `NeuronProvider` is mostly a matter of the value
 * being accepted everywhere a provider is validated or looked up, so that
 * `create_neuron` with `provider: 'agy-cli'` succeeds and the studio can
 * display the neuron.
 *
 * These tests pin the four places a missing provider key bites:
 *   1. the Mongoose enum on the `neurons` collection (`create_neuron` saves
 *      through it, so a missing value is a ValidationError at write time),
 *   2. `capability-matrix` — an exhaustive `Record<NeuronProvider, …>`,
 *   3. `vision-matrix` — likewise,
 *   4. `NeuronRegistry.createModel` — the switch stays exhaustive, and an
 *      `agy-cli` neuron that reaches it is a routing bug, not a model.
 *
 * (4) carries more weight for this provider than for `claude-code`: a silent
 * fall-through to the `google` branch would build a real Gemini API model and
 * put a neuron that exists to spend a SUBSCRIPTION back on the metered API,
 * which is the exact bill it was added to avoid.
 *
 * No database connection and no LLM call is required by any of them.
 */

import { describe, it, expect } from 'vitest';
import Neuron from '../../src/lib/models/Neuron';
import {
  resolveToolStrategy,
  resolveHostedToolSpec,
} from '../../src/lib/neurons/capability-matrix';
import { resolveVisionCapability } from '../../src/lib/neurons/vision-matrix';
import { NeuronRegistry } from '../../src/lib/neurons/NeuronRegistry';
import type { NeuronConfig } from '../../src/lib/types/neuron';
import { AGY_EFFORT_LEVELS, CLAUDE_CODE_EFFORT_LEVELS } from '../../src/lib/types/neuron';

function agyConfig(overrides: Partial<NeuronConfig> = {}): NeuronConfig {
  return {
    id: 'agy-flash-3-8',
    name: 'Agy Flash 3.8',
    provider: 'agy-cli',
    endpoint: 'agy-cli://worker',
    model: 'gemini-3.8-flash',
    role: 'worker',
    tier: 1,
    ...overrides,
  };
}

function agyDoc(over: Record<string, unknown> = {}) {
  return new Neuron({
    neuronId: 'agy-flash-3-8',
    userId: 'u-test',
    isDefault: false,
    name: 'Agy Flash 3.8',
    provider: 'agy-cli',
    endpoint: 'agy-cli://worker',
    model: 'gemini-3.8-flash',
    temperature: 0,
    role: 'worker',
    tier: 1,
    ...over,
  });
}

describe('Neuron model — provider enum', () => {
  it('accepts provider "agy-cli"', () => {
    const err = agyDoc().validateSync();
    expect(err?.errors?.provider).toBeUndefined();
    expect(err).toBeUndefined();
  });

  it('accepts the three effort levels agy actually knows', () => {
    for (const effort of AGY_EFFORT_LEVELS) {
      expect(agyDoc({ parameters: { effort } }).validateSync()).toBeUndefined();
    }
  });

  it('still accepts a claude-code-only effort level, because the enum is the UNION', () => {
    // Deliberate: a neuron can be re-pointed between the two CLI providers
    // without a data migration, and `agyCliExecutor` degrades a level it does
    // not know to its own default rather than failing the run.
    expect(CLAUDE_CODE_EFFORT_LEVELS).toContain('xhigh');
    expect(agyDoc({ parameters: { effort: 'xhigh' } }).validateSync()).toBeUndefined();
  });

  it('still rejects an unknown provider', () => {
    const doc = agyDoc({ provider: 'antigravity' });
    expect(doc.validateSync()?.errors?.provider).toBeDefined();
  });
});

describe('capability-matrix — agy-cli', () => {
  it('resolves to the "none" tool strategy for any model', () => {
    // The CLI runs its own tool loop and does not even expose MCP tools as
    // named functions (there is one `call_mcp_tool` meta-tool), so there is
    // nothing a binding could name. The executor reads `config.tools` itself
    // and serves them over the run bridge.
    for (const model of ['gemini-3.8-flash', 'claude-sonnet-4-6', 'anything-at-all']) {
      expect(resolveToolStrategy('agy-cli', model)).toBe('none');
    }
    expect(resolveToolStrategy('agy-cli', 'gemini-3.8-flash', 'auto')).toBe('none');
  });

  it('returns an explicit override verbatim, as for every other provider', () => {
    expect(resolveToolStrategy('agy-cli', 'gemini-3.8-flash', 'native')).toBe('native');
  });

  it('exposes no hosted tool specs', () => {
    for (const capability of ['web_search', 'code_execution', 'url_context'] as const) {
      expect(resolveHostedToolSpec('agy-cli', 'gemini-3.8-flash', capability)).toBeNull();
    }
  });
});

describe('vision-matrix — agy-cli', () => {
  it('is not vision-capable for any model', () => {
    // Whatever the underlying Gemini model can do through the API, the prompt
    // here is a single argv string and the reply is a JSON envelope.
    expect(resolveVisionCapability('agy-cli', 'gemini-3.8-flash')).toBe(false);
    expect(resolveVisionCapability('agy-cli', 'gemini-3.8-flash', 'auto')).toBe(false);
    expect(resolveVisionCapability('agy-cli', 'claude-opus-4-6-thinking')).toBe(false);
  });

  it('still honours an explicit per-neuron override', () => {
    expect(resolveVisionCapability('agy-cli', 'gemini-3.8-flash', true)).toBe(true);
  });
});

describe('NeuronRegistry.createModel — agy-cli', () => {
  const registry = new NeuronRegistry({
    databaseUrl: 'mongodb://localhost:27017/test-noop',
  });

  it('throws a NeuronProviderError naming the executor instead of building a chat model', () => {
    expect(() => registry.createModel(agyConfig())).toThrowError(/agyCliExecutor/);
    try {
      registry.createModel(agyConfig());
      throw new Error('expected createModel to throw');
    } catch (err) {
      expect((err as Error).name).toBe('NeuronProviderError');
      // Not the generic "Unknown provider" branch — the switch is exhaustive.
      expect((err as Error).message).not.toMatch(/Unknown provider/);
    }
  });

  it('never quietly builds a metered Gemini model for a subscription neuron', () => {
    // The failure this guards is specific and expensive: falling through to the
    // `google` branch would answer on the paid API while the neuron, the run
    // record and the rate card all still said `agy-cli`.
    let built: unknown;
    try {
      built = registry.createModel(agyConfig({ apiKey: 'AIza-would-be-metered' }));
    } catch {
      built = undefined;
    }
    expect(built).toBeUndefined();
  });
});
