/**
 * Phase 7 — media-vision-capability-matrix
 *
 * Acceptance: resolveVisionCapability returns
 *   true  for gpt-4o, claude-3, gemini-2, llava
 *   false for granite4, red
 */

import { describe, it, expect } from 'vitest';
import { resolveVisionCapability } from '../../src/lib/neurons/vision-matrix';

describe('resolveVisionCapability — acceptance matrix', () => {
  it('returns true for gpt-4o', () => {
    expect(resolveVisionCapability('openai', 'gpt-4o')).toBe(true);
    expect(resolveVisionCapability('openai', 'gpt-4o-mini')).toBe(true);
    expect(resolveVisionCapability('openai', 'gpt-4o-2024-08-06')).toBe(true);
  });

  it('returns true for claude-3 (and claude-4)', () => {
    expect(resolveVisionCapability('anthropic', 'claude-3-opus-20240229')).toBe(true);
    expect(resolveVisionCapability('anthropic', 'claude-3-5-sonnet-20241022')).toBe(true);
    expect(resolveVisionCapability('anthropic', 'claude-3-haiku-20240307')).toBe(true);
    expect(resolveVisionCapability('anthropic', 'claude-4-sonnet-20250514')).toBe(true);
  });

  it('returns true for gemini-2', () => {
    expect(resolveVisionCapability('google', 'gemini-2.0-flash')).toBe(true);
    expect(resolveVisionCapability('google', 'gemini-2.5-pro')).toBe(true);
    // gemini-1.5 is also vision-capable
    expect(resolveVisionCapability('google', 'gemini-1.5-pro')).toBe(true);
  });

  it('returns true for llava (Ollama)', () => {
    expect(resolveVisionCapability('ollama', 'llava')).toBe(true);
    expect(resolveVisionCapability('ollama', 'llava:7b')).toBe(true);
    expect(resolveVisionCapability('ollama', 'llava:13b-v1.6')).toBe(true);
  });

  it('returns false for granite4 (Ollama, no vision)', () => {
    expect(resolveVisionCapability('ollama', 'granite4')).toBe(false);
    expect(resolveVisionCapability('ollama', 'granite4:tiny-h')).toBe(false);
    expect(resolveVisionCapability('ollama', 'granite4:micro')).toBe(false);
  });

  it('returns false for red (the in-house chat model — no vision)', () => {
    expect(resolveVisionCapability('ollama', 'red')).toBe(false);
    expect(resolveVisionCapability('ollama', 'red:tiny')).toBe(false);
  });
});

describe('resolveVisionCapability — other vision-capable Ollama families', () => {
  it.each([
    'llama3.2-vision',
    'llama3.2-vision:11b',
    'qwen2.5-vl:7b',
    'minicpm-v:8b',
    'moondream:1.8b',
    'bakllava:7b',
    'gemma3:4b',
  ])('returns true for %s', (model) => {
    expect(resolveVisionCapability('ollama', model)).toBe(true);
  });

  it.each([
    'llama3.1',
    'llama3.2',          // base llama3.2 has no vision; -vision variant does
    'qwen2.5:7b',        // base qwen2.5 has no vision; -vl variant does
    'mistral-nemo',
    'firefunction-v2',
    'command-r:35b',
    'deepseek-r1',
  ])('returns false for non-vision Ollama family %s', (model) => {
    expect(resolveVisionCapability('ollama', model)).toBe(false);
  });
});

describe('resolveVisionCapability — non-vision OpenAI/Anthropic/Google models', () => {
  it('returns false for legacy gpt-3.5', () => {
    expect(resolveVisionCapability('openai', 'gpt-3.5-turbo')).toBe(false);
  });

  it('returns false for claude-2 (pre-vision)', () => {
    expect(resolveVisionCapability('anthropic', 'claude-2.1')).toBe(false);
    expect(resolveVisionCapability('anthropic', 'claude-instant-1.2')).toBe(false);
  });

  it('returns false for gemini-1.0', () => {
    expect(resolveVisionCapability('google', 'gemini-1.0-pro')).toBe(false);
    expect(resolveVisionCapability('google', 'gemini-pro')).toBe(false);
  });
});

describe('resolveVisionCapability — override semantics', () => {
  it('explicit true wins over a non-matching matrix', () => {
    // granite4 is matrix=false; explicit true overrides.
    expect(resolveVisionCapability('ollama', 'granite4', true)).toBe(true);
  });

  it('explicit false wins over a matching matrix entry', () => {
    expect(resolveVisionCapability('openai', 'gpt-4o', false)).toBe(false);
    expect(resolveVisionCapability('anthropic', 'claude-3-5-sonnet', false)).toBe(false);
  });

  it("'auto' override consults the matrix (same as undefined)", () => {
    expect(resolveVisionCapability('openai', 'gpt-4o', 'auto')).toBe(true);
    expect(resolveVisionCapability('ollama', 'granite4', 'auto')).toBe(false);
  });

  it('undefined override consults the matrix', () => {
    expect(resolveVisionCapability('openai', 'gpt-4o', undefined)).toBe(true);
  });
});

describe('resolveVisionCapability — custom provider default', () => {
  it('returns true for any custom model unless overridden', () => {
    expect(resolveVisionCapability('custom', 'whatever')).toBe(true);
    expect(resolveVisionCapability('custom', 'my-text-only-endpoint')).toBe(true);
  });

  it('user can opt-out a custom neuron via explicit false', () => {
    expect(resolveVisionCapability('custom', 'my-text-only-endpoint', false)).toBe(false);
  });
});
