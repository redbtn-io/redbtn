import { describe, expect, it } from 'vitest';
import Neuron from '../../src/lib/models/Neuron';
import { NeuronRegistry } from '../../src/lib/neurons/NeuronRegistry';
import { resolveHostedToolSpec, resolveToolStrategy } from '../../src/lib/neurons/capability-matrix';
import { resolveVisionCapability } from '../../src/lib/neurons/vision-matrix';
import type { NeuronConfig } from '../../src/lib/types/neuron';

const config: NeuronConfig = {
  id: 'copilot-test', name: 'Copilot SDK', provider: 'copilot-sdk',
  endpoint: 'copilot-sdk://worker', model: 'gpt-5', role: 'worker', tier: 0,
};

describe('copilot-sdk provider plumbing', () => {
  it('is accepted by the neuron schema as a regular provider', () => {
    const doc = new Neuron({
      neuronId: config.id, userId: 'u-test', isDefault: false, name: config.name,
      provider: config.provider, endpoint: config.endpoint, model: config.model,
      temperature: 0, role: 'worker', tier: 0, secretName: 'COPILOT_GITHUB_TOKEN',
    });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.isSystem).not.toBe(true);
  });

  it('routes tools only through the executor bridge and exposes no hosted tools', () => {
    expect(resolveToolStrategy('copilot-sdk', 'gpt-5')).toBe('none');
    expect(resolveToolStrategy('copilot-sdk', 'gpt-5', 'auto')).toBe('none');
    expect(resolveHostedToolSpec('copilot-sdk', 'gpt-5', 'web_search')).toBeNull();
  });

  it('is text-only in the capability matrix', () => {
    expect(resolveVisionCapability('copilot-sdk', 'gpt-5')).toBe(false);
  });

  it('cannot fall through to a metered API chat model', () => {
    const registry = new NeuronRegistry({ databaseUrl: 'mongodb://localhost:27017/test-noop' });
    expect(() => registry.createModel({ ...config, apiKey: 'test-placeholder' })).toThrow(/copilotSdkExecutor/);
  });
});
