import { describe, expect, it } from 'vitest';
import Neuron from '../../src/lib/models/Neuron';
import { NeuronRegistry } from '../../src/lib/neurons/NeuronRegistry';
import { resolveHostedToolSpec, resolveToolStrategy } from '../../src/lib/neurons/capability-matrix';
import { resolveVisionCapability } from '../../src/lib/neurons/vision-matrix';
import type { NeuronConfig } from '../../src/lib/types/neuron';

describe('opencode and opencode-zen provider plumbing', () => {
  it('accepts provider "opencode" in neuron schema', () => {
    const doc = new Neuron({
      neuronId: 'opencode-test',
      userId: 'u-test',
      isDefault: false,
      name: 'OpenCode Test',
      provider: 'opencode',
      endpoint: 'opencode://worker',
      model: 'opencode/big-pickle',
      temperature: 0,
      role: 'worker',
      tier: 0,
    });
    expect(doc.validateSync()).toBeUndefined();
  });

  it('accepts provider "opencode-zen" and "zen" in neuron schema', () => {
    const docZen = new Neuron({
      neuronId: 'opencode-zen-test',
      userId: 'u-test',
      isDefault: false,
      name: 'OpenCode Zen Test',
      provider: 'opencode-zen',
      endpoint: 'https://opencode.ai/zen/v1',
      model: 'big-pickle',
      temperature: 0,
      role: 'worker',
      tier: 0,
      secretName: 'OPENCODE_ZEN_API_KEY',
    });
    expect(docZen.validateSync()).toBeUndefined();

    const docZenAlias = new Neuron({
      neuronId: 'zen-alias-test',
      userId: 'u-test',
      isDefault: false,
      name: 'Zen Alias Test',
      provider: 'zen',
      endpoint: 'https://opencode.ai/zen/v1',
      model: 'deepseek-v4-pro',
      temperature: 0,
      role: 'worker',
      tier: 0,
    });
    expect(docZenAlias.validateSync()).toBeUndefined();
  });

  it('resolves tool strategy properly for opencode and zen', () => {
    // opencode runs via CLI loop
    expect(resolveToolStrategy('opencode', 'big-pickle')).toBe('none');
    expect(resolveHostedToolSpec('opencode', 'big-pickle', 'web_search')).toBeNull();

    // opencode-zen / zen support native tool calling
    expect(resolveToolStrategy('opencode-zen', 'big-pickle')).toBe('native');
    expect(resolveToolStrategy('zen', 'deepseek-v4-pro')).toBe('native');
  });

  it('resolves vision capability matrix for opencode and zen models', () => {
    // opencode CLI is text-only
    expect(resolveVisionCapability('opencode', 'big-pickle')).toBe(false);

    // opencode-zen vision models
    expect(resolveVisionCapability('opencode-zen', 'deepseek-v4-flash-vision-exp')).toBe(true);
    expect(resolveVisionCapability('opencode-zen', 'gpt-4o')).toBe(true);
    expect(resolveVisionCapability('opencode-zen', 'claude-sonnet-5')).toBe(true);
    expect(resolveVisionCapability('opencode-zen', 'big-pickle')).toBe(false);

    // zen alias vision models
    expect(resolveVisionCapability('zen', 'gemini-3.8-flash')).toBe(true);
    expect(resolveVisionCapability('zen', 'big-pickle')).toBe(false);
  });

  it('opencode provider throws in createModel because it runs via opencodeExecutor', () => {
    const registry = new NeuronRegistry({ databaseUrl: 'mongodb://localhost:27017/test-noop' });
    const config: NeuronConfig = {
      id: 'opencode-test',
      name: 'OpenCode Test',
      provider: 'opencode',
      endpoint: 'opencode://worker',
      model: 'big-pickle',
      role: 'worker',
      tier: 0,
    };
    expect(() => registry.createModel(config)).toThrow(/opencodeExecutor/);
  });

  it('opencode-zen / zen builds ChatOpenAI pointing to https://opencode.ai/zen/v1', () => {
    const registry = new NeuronRegistry({ databaseUrl: 'mongodb://localhost:27017/test-noop' });
    const config: NeuronConfig = {
      id: 'zen-test',
      name: 'Zen Test',
      provider: 'opencode-zen',
      endpoint: 'https://opencode.ai/zen/v1',
      model: 'big-pickle',
      apiKey: 'test-zen-key',
      role: 'worker',
      tier: 0,
    };
    const model = registry.createModel(config);
    expect(model).toBeDefined();
    expect((model as any).model || (model as any).modelName).toBe('big-pickle');
  });
});
