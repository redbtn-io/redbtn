import { describe, it, expect } from 'vitest';
import { looksLikeProviderAuthError, missingSecretMessage } from '../../src/lib/neurons/missing-secret';

const cfg = { id: 'red-code-or', provider: 'custom' as const, secretName: 'OPENROUTER_KEY', apiKey: undefined };

describe('looksLikeProviderAuthError', () => {
  it('matches the OpenRouter/LangChain 401 text', () => {
    expect(looksLikeProviderAuthError(new Error('401 Missing Authentication header'))).toBe(true);
  });
  it('matches a status-only SDK error', () => {
    expect(looksLikeProviderAuthError(Object.assign(new Error('boom'), { status: 401 }))).toBe(true);
  });
  it('follows the cause chain of a wrapped error', () => {
    const inner = Object.assign(new Error('x'), { status: 403 });
    const outer = Object.assign(new Error('LLM invocation failed'), { cause: inner });
    expect(looksLikeProviderAuthError(outer)).toBe(true);
  });
  it('ignores rate limits and other failures', () => {
    expect(looksLikeProviderAuthError(Object.assign(new Error('429 Too Many Requests'), { status: 429 }))).toBe(false);
    expect(looksLikeProviderAuthError(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('missingSecretMessage', () => {
  const err = new Error('LLM invocation failed during tool-use loop (iteration 1): 401 Missing Authentication header');

  it('names the secret, the neuron and the user when the secret did not resolve', () => {
    const msg = missingSecretMessage(err, cfg, 'u1');
    expect(msg).toContain("secret 'OPENROUTER_KEY' is not set for this account (user u1)");
    expect(msg).toContain("Neuron 'red-code-or'");
  });
  it('leaves the error alone when the key resolved (a real bad key)', () => {
    expect(missingSecretMessage(err, { ...cfg, apiKey: 'sk-x' }, 'u1')).toBeNull();
  });
  it('leaves the error alone when the neuron names no secret (platform key path)', () => {
    expect(missingSecretMessage(err, { ...cfg, secretName: undefined }, 'u1')).toBeNull();
  });
  it('leaves non-auth errors alone even with a missing secret', () => {
    expect(missingSecretMessage(new Error('429 rate limited'), cfg, 'u1')).toBeNull();
  });
  it('handles a missing config', () => {
    expect(missingSecretMessage(err, null)).toBeNull();
  });
});
