/**
 * `claude-code` provider plumbing.
 *
 * Phase 0 PR 2 of the workspace/subscription-neuron work adds `'claude-code'`
 * as a first-class `NeuronProvider`. Nothing behavioural ships with it: the
 * value simply has to be accepted everywhere a provider is validated or looked
 * up, so that `create_neuron` with `provider: 'claude-code'` succeeds and the
 * studio can display the neuron.
 *
 * These tests pin the four places a missing provider key bites:
 *   1. the Mongoose enum on the `neurons` collection (`create_neuron` saves
 *      through it, so a missing value is a ValidationError at write time),
 *   2. `capability-matrix` — an exhaustive `Record<NeuronProvider, …>`,
 *   3. `vision-matrix` — likewise,
 *   4. `NeuronRegistry.createModel` — the switch stays exhaustive, and a
 *      `claude-code` neuron that reaches it is a routing bug, not a model.
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

function claudeCodeConfig(overrides: Partial<NeuronConfig> = {}): NeuronConfig {
  return {
    id: 'opus-5',
    name: 'Opus 5',
    provider: 'claude-code',
    endpoint: 'claude-code://worker',
    model: 'claude-opus-5',
    role: 'worker',
    tier: 1,
    ...overrides,
  };
}

describe('Neuron model — provider enum', () => {
  it('accepts provider "claude-code"', () => {
    const doc = new Neuron({
      neuronId: 'opus-5',
      userId: 'u-test',
      isDefault: false,
      name: 'Opus 5',
      provider: 'claude-code',
      endpoint: 'claude-code://worker',
      model: 'claude-opus-5',
      temperature: 0,
      role: 'worker',
      tier: 1,
    });

    const err = doc.validateSync();
    expect(err?.errors?.provider).toBeUndefined();
    expect(err).toBeUndefined();
  });

  it('still accepts every pre-existing provider', () => {
    for (const provider of ['ollama', 'openai', 'anthropic', 'google', 'custom']) {
      const doc = new Neuron({
        neuronId: `n-${provider}`,
        userId: 'u-test',
        isDefault: false,
        name: provider,
        provider,
        endpoint: 'https://example.invalid',
        model: 'm',
        temperature: 0,
        role: 'worker',
        tier: 1,
      });
      expect(doc.validateSync()).toBeUndefined();
    }
  });

  it('still rejects an unknown provider', () => {
    const doc = new Neuron({
      neuronId: 'n-bogus',
      userId: 'u-test',
      isDefault: false,
      name: 'bogus',
      provider: 'claude-cli',
      endpoint: 'claude-code://worker',
      model: 'claude-opus-5',
      temperature: 0,
      role: 'worker',
      tier: 1,
    });

    expect(doc.validateSync()?.errors?.provider).toBeDefined();
  });
});

describe('capability-matrix — claude-code', () => {
  it('resolves to the "none" tool strategy for any model', () => {
    // The CLI runs its own tool loop and never returns `tool_calls`, so there
    // is nothing to bind. The executor reads `config.tools` itself.
    expect(resolveToolStrategy('claude-code', 'claude-opus-5')).toBe('none');
    expect(resolveToolStrategy('claude-code', 'claude-fable-5-1')).toBe('none');
    expect(resolveToolStrategy('claude-code', 'anything-at-all')).toBe('none');
    expect(resolveToolStrategy('claude-code', 'claude-opus-5', 'auto')).toBe('none');
  });

  it('returns an explicit override verbatim, as for every other provider', () => {
    expect(resolveToolStrategy('claude-code', 'claude-opus-5', 'native')).toBe('native');
  });

  it('exposes no hosted tool specs', () => {
    expect(resolveHostedToolSpec('claude-code', 'claude-opus-5', 'web_search')).toBeNull();
    expect(resolveHostedToolSpec('claude-code', 'claude-opus-5', 'code_execution')).toBeNull();
    expect(resolveHostedToolSpec('claude-code', 'claude-opus-5', 'url_context')).toBeNull();
  });
});

describe('vision-matrix — claude-code', () => {
  it('is not vision-capable for any model', () => {
    expect(resolveVisionCapability('claude-code', 'claude-opus-5')).toBe(false);
    expect(resolveVisionCapability('claude-code', 'claude-opus-5', 'auto')).toBe(false);
    expect(resolveVisionCapability('claude-code', 'claude-4-sonnet')).toBe(false);
  });

  it('still honours an explicit per-neuron override', () => {
    expect(resolveVisionCapability('claude-code', 'claude-opus-5', true)).toBe(true);
  });
});

describe('NeuronRegistry.createModel — claude-code', () => {
  const registry = new NeuronRegistry({
    databaseUrl: 'mongodb://localhost:27017/test-noop',
  });

  it('throws a NeuronProviderError naming the executor instead of building a chat model', () => {
    expect(() => registry.createModel(claudeCodeConfig())).toThrowError(
      /claudeCodeExecutor/,
    );
    try {
      registry.createModel(claudeCodeConfig());
      throw new Error('expected createModel to throw');
    } catch (err) {
      expect((err as Error).name).toBe('NeuronProviderError');
      // Not the generic "Unknown provider" branch — the switch is exhaustive.
      expect((err as Error).message).not.toMatch(/Unknown provider/);
    }
  });

  it('still throws the unknown-provider error for a value outside the union', () => {
    const bogus = claudeCodeConfig({
      provider: 'claude-cli' as NeuronConfig['provider'],
    });
    expect(() => registry.createModel(bogus)).toThrowError(/Unknown provider/);
  });
});
