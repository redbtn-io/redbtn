import { describe, expect, it } from 'vitest';
import {
  resolveOpencodeModel,
  resolveOpencodeBinary,
  OpencodeCliError,
  runOpencodeStep,
} from '../../src/lib/nodes/universal/executors/opencodeExecutor';
import { OPENCODE_FALLBACK_CODES } from '../../src/lib/nodes/universal/executors/neuronFallback';

describe('opencodeExecutor', () => {
  it('resolves model names with opencode/ prefix if absent', () => {
    expect(resolveOpencodeModel('')).toBe('opencode/big-pickle');
    expect(resolveOpencodeModel('big-pickle')).toBe('opencode/big-pickle');
    expect(resolveOpencodeModel('opencode/big-pickle')).toBe('opencode/big-pickle');
    expect(resolveOpencodeModel('deepseek/deepseek-v4-pro')).toBe('deepseek/deepseek-v4-pro');
  });

  it('resolves binary or falls back to opencode', () => {
    const bin = resolveOpencodeBinary();
    expect(bin).toBeTruthy();
    expect(typeof bin).toBe('string');
  });

  it('defines opencode fallback error codes', () => {
    expect(OPENCODE_FALLBACK_CODES.has('opencode_spawn_failed')).toBe(true);
    expect(OPENCODE_FALLBACK_CODES.has('opencode_rate_limited')).toBe(true);
    expect(OPENCODE_FALLBACK_CODES.has('opencode_timeout')).toBe(true);
    expect(OPENCODE_FALLBACK_CODES.has('opencode_failed')).toBe(true);
  });

  it('OpencodeCliError creates error with code and message', () => {
    const err = new OpencodeCliError('opencode_rate_limited', 'Too many requests');
    expect(err.code).toBe('opencode_rate_limited');
    expect(err.message).toBe('Too many requests');
    expect(err.name).toBe('OpencodeCliError');
  });

  it('executes a step with mock or live opencode if binary is present', async () => {
    // If opencode binary is installed, verify runOpencodeStep executes
    const bin = resolveOpencodeBinary();
    if (bin && bin.includes('opencode')) {
      const result = await runOpencodeStep({
        config: {
          stepId: 'test-step',
          type: 'neuron',
          outputField: 'reply',
          prompt: 'Say PONG in one word',
        },
        state: { runId: 'run-test-123' },
        neuronCfg: {
          id: 'opencode-test',
          name: 'OpenCode Test',
          provider: 'opencode',
          endpoint: 'opencode://worker',
          model: 'big-pickle',
          role: 'worker',
          tier: 0,
        },
        neuronId: 'opencode-test',
        userId: 'u-test',
        emitUsage: () => {},
      });
      expect(result).toBeDefined();
      expect(result.reply).toBeDefined();
      expect(typeof result.reply).toBe('string');
      expect((result.reply as string).length).toBeGreaterThan(0);
    }
  });

  it('dispatches through executeNeuron when provider is opencode', async () => {
    const { executeNeuron } = await import('../../src/lib/nodes/universal/executors/neuronExecutor');
    const neuronRegistry = {
      getConfig: async (id: string) => ({
        id,
        name: 'OpenCode Test',
        provider: 'opencode',
        endpoint: 'opencode://worker',
        model: 'big-pickle',
        role: 'worker',
        tier: 0,
      }),
      getModel: async () => {
        throw new Error('should not call getModel for opencode');
      },
      callNeuron: async () => {
        throw new Error('should not call callNeuron for opencode');
      },
    };

    const state = {
      neuronRegistry,
      runId: 'run-e2e-opencode',
      data: {},
    };

    const config = {
      stepId: 'step-1',
      type: 'neuron' as const,
      outputField: 'answer',
      neuronId: 'opencode-neuron-1',
      userPrompt: 'Reply with the single word PONG',
    };

    const result = await executeNeuron(config, state);
    expect(result.answer).toBeDefined();
    expect(typeof result.answer).toBe('string');
  });
});
