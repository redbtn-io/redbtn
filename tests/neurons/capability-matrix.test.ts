/**
 * @file Capability Matrix Tests
 * @description Verify resolveToolStrategy resolution for known providers/models
 *
 * Exercises the static lookup table used by neuron steps with attached
 * tools to pick a binding strategy when `toolStrategy: 'auto'`.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveToolStrategy,
  isLoopingStrategy,
} from '../../src/lib/neurons/capability-matrix';

describe('resolveToolStrategy', () => {
  describe('explicit overrides', () => {
    it('returns native when override is native', () => {
      expect(resolveToolStrategy('ollama', 'unknown-model', 'native')).toBe('native');
    });

    it('returns prompt-injection when override is prompt-injection', () => {
      expect(resolveToolStrategy('openai', 'gpt-4', 'prompt-injection')).toBe('prompt-injection');
    });

    it('returns structured-output when override is structured-output', () => {
      expect(resolveToolStrategy('openai', 'gpt-4', 'structured-output')).toBe('structured-output');
    });

    it('returns none when override is none', () => {
      expect(resolveToolStrategy('anthropic', 'claude-3-5-sonnet', 'none')).toBe('none');
    });

    it('falls through to matrix when override is auto', () => {
      expect(resolveToolStrategy('openai', 'gpt-4-turbo', 'auto')).toBe('native');
    });

    it('falls through to matrix when override is undefined', () => {
      expect(resolveToolStrategy('anthropic', 'claude-3-5-sonnet')).toBe('native');
    });
  });

  describe('Anthropic models', () => {
    it('claude-3-5-sonnet resolves to native', () => {
      expect(resolveToolStrategy('anthropic', 'claude-3-5-sonnet-20241022')).toBe('native');
    });

    it('claude-3-opus resolves to native', () => {
      expect(resolveToolStrategy('anthropic', 'claude-3-opus-20240229')).toBe('native');
    });

    it('claude-haiku resolves to native', () => {
      expect(resolveToolStrategy('anthropic', 'claude-haiku-4')).toBe('native');
    });
  });

  describe('OpenAI models', () => {
    it('gpt-4 resolves to native', () => {
      expect(resolveToolStrategy('openai', 'gpt-4')).toBe('native');
    });

    it('gpt-4-turbo resolves to native', () => {
      expect(resolveToolStrategy('openai', 'gpt-4-turbo')).toBe('native');
    });

    it('gpt-3.5-turbo resolves to native', () => {
      expect(resolveToolStrategy('openai', 'gpt-3.5-turbo')).toBe('native');
    });

    it('gpt-5 resolves to native', () => {
      expect(resolveToolStrategy('openai', 'gpt-5')).toBe('native');
    });

    it('o1-preview resolves to native', () => {
      expect(resolveToolStrategy('openai', 'o1-preview')).toBe('native');
    });

    it('o3-mini resolves to native', () => {
      expect(resolveToolStrategy('openai', 'o3-mini')).toBe('native');
    });

    it('unknown openai model falls back to none', () => {
      expect(resolveToolStrategy('openai', 'davinci-003')).toBe('none');
    });
  });

  describe('Google models', () => {
    it('gemini-1.5-pro resolves to native', () => {
      expect(resolveToolStrategy('google', 'gemini-1.5-pro')).toBe('native');
    });

    it('gemini-2.0-flash resolves to native', () => {
      expect(resolveToolStrategy('google', 'gemini-2.0-flash')).toBe('native');
    });

    it('gemini-3.0 resolves to native', () => {
      expect(resolveToolStrategy('google', 'gemini-3.0')).toBe('native');
    });

    it('older gemini-1.0 falls back to none', () => {
      expect(resolveToolStrategy('google', 'gemini-1.0-pro')).toBe('none');
    });
  });

  describe('Ollama models', () => {
    it('llama3.1 resolves to native', () => {
      expect(resolveToolStrategy('ollama', 'llama3.1:8b')).toBe('native');
    });

    it('llama3.2 resolves to native', () => {
      expect(resolveToolStrategy('ollama', 'llama3.2')).toBe('native');
    });

    it('llama3.3:70b resolves to native', () => {
      expect(resolveToolStrategy('ollama', 'llama3.3:70b')).toBe('native');
    });

    it('qwen2.5 resolves to native', () => {
      expect(resolveToolStrategy('ollama', 'qwen2.5:14b')).toBe('native');
    });

    it('mistral-nemo resolves to native', () => {
      expect(resolveToolStrategy('ollama', 'mistral-nemo')).toBe('native');
    });

    it('firefunction-v2 resolves to native', () => {
      expect(resolveToolStrategy('ollama', 'firefunction-v2')).toBe('native');
    });

    it('unknown ollama model falls back to prompt-injection', () => {
      expect(resolveToolStrategy('ollama', 'granite4:tiny-h')).toBe('prompt-injection');
      expect(resolveToolStrategy('ollama', 'phi3')).toBe('prompt-injection');
      expect(resolveToolStrategy('ollama', 'red')).toBe('prompt-injection');
    });
  });

  describe('Custom provider', () => {
    it('any model on custom resolves to native', () => {
      expect(resolveToolStrategy('custom', 'my-model')).toBe('native');
      expect(resolveToolStrategy('custom', 'whatever')).toBe('native');
    });
  });

  describe('Case insensitivity', () => {
    it('matches model names case-insensitively', () => {
      expect(resolveToolStrategy('anthropic', 'CLAUDE-3-5-SONNET')).toBe('native');
      expect(resolveToolStrategy('openai', 'GPT-4-TURBO')).toBe('native');
    });
  });
});

describe('isLoopingStrategy', () => {
  it('native is a looping strategy', () => {
    expect(isLoopingStrategy('native')).toBe(true);
  });

  it('prompt-injection is a looping strategy', () => {
    expect(isLoopingStrategy('prompt-injection')).toBe(true);
  });

  it('structured-output is NOT a looping strategy', () => {
    expect(isLoopingStrategy('structured-output')).toBe(false);
  });

  it('none is NOT a looping strategy', () => {
    expect(isLoopingStrategy('none')).toBe(false);
  });
});
