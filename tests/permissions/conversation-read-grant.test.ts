/**
 * Regression: capability profiles written before conversation reads were gated
 * (engine 0.0.250, #425) — notably the auto-generated `exec-migration` profile
 * (exec/computer/state/knowledge only) — denied get_context_history, so every
 * graph with a `context` node died at its first step. These tests pin the
 * gate's behaviour, the actionable denial message, and the red-coder profile.
 */

import { describe, it, expect } from 'vitest';
import { enforceToolCapability } from '../../src/lib/permissions/enforce';
import { decide } from '../../src/lib/permissions/matcher';
import { RED_CODER_CAPABILITY_PROFILE } from '../../src/lib/permissions/red-coder-profile';
import { CapabilityDeniedError, type CapabilityProfile } from '../../src/lib/permissions/types';
import redCoderJson from '../../ops/red-coder/red-coder-capability-profile.json';

const EXEC_MIGRATION: CapabilityProfile = {
  name: 'exec-migration',
  capabilities: [
    { resource: 'exec', actions: ['execute'], selector: '*' },
    { resource: 'computer', actions: ['control'], selector: '*' },
    { resource: 'state', actions: ['read', 'write', 'create', 'delete'], selector: '*' },
    { resource: 'knowledge', actions: ['read', 'write', 'create', 'delete'], selector: '*' },
  ],
};

const CONTEXT_ARGS = { conversationId: '6abc7a888502df4abc26a701', format: 'llm' };

describe('conversation:read gate for context loading', () => {
  it('an unprofiled run may load its conversation history (fail-open)', () => {
    expect(() => enforceToolCapability(null, 'get_context_history', CONTEXT_ARGS)).not.toThrow();
  });

  it('a profile without conversation grants denies get_context_history with an actionable message', () => {
    let err: unknown;
    try {
      enforceToolCapability(EXEC_MIGRATION, 'get_context_history', CONTEXT_ARGS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CapabilityDeniedError);
    const msg = (err as Error).message;
    expect(msg).toContain("agent profile 'exec-migration'");
    expect(msg).toContain('no conversation read grants');
    expect(msg).toContain('{"resource":"conversation","actions":["read"],"selector":"*"}');
  });

  it('adding conversation:read * (what the 2026-09-30 migration does) allows it', () => {
    const fixed: CapabilityProfile = {
      ...EXEC_MIGRATION,
      capabilities: [...EXEC_MIGRATION.capabilities, { resource: 'conversation', actions: ['read'], selector: '*' }],
    };
    expect(() => enforceToolCapability(fixed, 'get_context_history', CONTEXT_ARGS)).not.toThrow();
    expect(() => enforceToolCapability(fixed, 'get_messages', CONTEXT_ARGS)).not.toThrow();
  });

  it('a denial with a narrower existing grant still lists the allowed selectors, not the add-hint', () => {
    const narrow: CapabilityProfile = {
      name: 'narrow',
      capabilities: [{ resource: 'conversation', actions: ['read'], selector: 'conv_a' }],
    };
    const d = decide(narrow, 'conversation', 'read', 'conv_b');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('Allowed conversation read selectors: conv_a.');
    expect(d.reason).not.toContain('To allow it');
  });
});

describe('red-coder-ws-jail loads chat context', () => {
  it('grants conversation:read so coder-ctx-chat can call get_context_history', () => {
    expect(decide(RED_CODER_CAPABILITY_PROFILE, 'conversation', 'read', 'any_conversation').allowed).toBe(true);
    // Still no conversation writes / computer control.
    expect(decide(RED_CODER_CAPABILITY_PROFILE, 'computer', 'control', 'desktop').allowed).toBe(false);
  });

  it('the deployable JSON carries the same conversation grant', () => {
    const caps = (redCoderJson as { capabilities: Array<{ resource: string; actions: string[]; selector: string }> })
      .capabilities;
    expect(caps).toContainEqual({ resource: 'conversation', actions: ['read'], selector: '*' });
  });
});
