import { describe, expect, it } from 'vitest';
import { ChatAnthropic } from '@langchain/anthropic';
import { NeuronRegistry } from '../../src/lib/neurons/NeuronRegistry';
import type { NeuronConfig } from '../../src/lib/types/neuron';

const base = {
  id: 'claude-api-test',
  name: 'Claude API test',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  apiKey: 'sk-ant-test',
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 32000,
} as unknown as NeuronConfig;

// The request body ChatAnthropic would send, without sending it.
function requestParams(config: NeuronConfig) {
  const registry = new NeuronRegistry({ databaseUrl: 'mongodb://localhost:27017/test-noop' });
  const model = registry.createModel(config);
  expect(model).toBeInstanceOf(ChatAnthropic);
  return (model as ChatAnthropic).invocationParams();
}

describe('anthropic provider', () => {
  it('sends no sampling parameters, even when the neuron stores them', () => {
    const params = requestParams(base);
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
    expect(params.top_k).toBeUndefined();
    expect(params.max_tokens).toBe(32000);
  });

  it('runs adaptive thinking instead of the rejected disabled default', () => {
    expect(requestParams(base).thinking).toEqual({ type: 'adaptive' });
  });

  it('maps parameters.effort to output_config.effort', () => {
    const params = requestParams({ ...base, parameters: { effort: 'high' } } as NeuronConfig);
    expect(params.output_config).toMatchObject({ effort: 'high' });
  });

  it('streams only when max_tokens is past the SDK non-streaming limit', () => {
    const registry = new NeuronRegistry({ databaseUrl: 'mongodb://localhost:27017/test-noop' });
    const small = registry.createModel({ ...base, maxTokens: 20000 } as NeuronConfig) as ChatAnthropic;
    const large = registry.createModel({ ...base, maxTokens: 64000 } as NeuronConfig) as ChatAnthropic;
    expect(small.streaming).toBe(false);
    expect(large.streaming).toBe(true);
  });

  it('leaves effort to the model default when the neuron sets none', () => {
    expect(requestParams(base).output_config?.effort).toBeUndefined();
  });
});
