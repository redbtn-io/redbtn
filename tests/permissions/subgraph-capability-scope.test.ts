/**
 * Subgraph-scoped capability profiles.
 *
 * A trusted subgraph (system, or owned by the run's user) that declares its own
 * `capabilities` runs under THAT profile for the duration of its invocation,
 * restoring the parent's when it returns. graphExecutor registers the profile
 * keyed by a unique per-invocation scopeId (the ephemeral thread_id) and stamps
 * that id into the subgraph's `state.data._capabilityScope`; getCapabilityProfile
 * resolves it. This test covers the resolution contract in contextLookup.
 */
import { describe, it, expect } from 'vitest';
import {
  getCapabilityProfile,
  setSubgraphProfile,
  clearSubgraphProfile,
} from '../../src/lib/run/contextLookup';

const parentProfile = {
  name: 'parent',
  capabilities: [{ resource: 'state', actions: ['read'], selector: '*' }],
};
const subProfile = {
  name: 'sub',
  capabilities: [{ resource: 'exec', actions: ['execute'], selector: '*' }],
};

describe('subgraph-scoped capability profile', () => {
  it('with no scope, resolves the parent (state-carried) profile', () => {
    const state = { data: { runId: 'r1' }, capabilityProfile: parentProfile };
    expect(getCapabilityProfile(state)?.name).toBe('parent');
  });

  it('with a registered scope, resolves the SUBGRAPH profile (can widen)', () => {
    setSubgraphProfile('scope-a', subProfile);
    const state = { data: { runId: 'r1', _capabilityScope: 'scope-a' }, capabilityProfile: parentProfile };
    expect(getCapabilityProfile(state)?.name).toBe('sub');
    clearSubgraphProfile('scope-a');
  });

  it('after the scope is cleared, restores the parent profile', () => {
    setSubgraphProfile('scope-b', subProfile);
    const state = { data: { runId: 'r1', _capabilityScope: 'scope-b' }, capabilityProfile: parentProfile };
    expect(getCapabilityProfile(state)?.name).toBe('sub');
    clearSubgraphProfile('scope-b');
    expect(getCapabilityProfile(state)?.name).toBe('parent');
  });

  it('an unknown/ghost scope falls back to the parent (fail-safe, no fabrication)', () => {
    const state = { data: { runId: 'r1', _capabilityScope: 'ghost' }, capabilityProfile: parentProfile };
    expect(getCapabilityProfile(state)?.name).toBe('parent');
  });

  it('concurrent scopes are isolated (no cross-invocation clobber)', () => {
    setSubgraphProfile('scope-x', subProfile);
    setSubgraphProfile('scope-y', parentProfile);
    const sx = { data: { runId: 'r1', _capabilityScope: 'scope-x' } };
    const sy = { data: { runId: 'r1', _capabilityScope: 'scope-y' } };
    expect(getCapabilityProfile(sx)?.name).toBe('sub');
    expect(getCapabilityProfile(sy)?.name).toBe('parent');
    clearSubgraphProfile('scope-x');
    clearSubgraphProfile('scope-y');
  });
});
