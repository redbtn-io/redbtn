/**
 * Data-permissions matcher + enforcement unit tests.
 *
 * Pure-logic coverage of the selector matcher, the profile decision function,
 * and the fail-closed `enforceToolCapability` gate — no run context, no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  selectorMatches,
  decide,
} from '../../src/lib/permissions/matcher';
import {
  enforceToolCapability,
  normalizeProfile,
} from '../../src/lib/permissions/enforce';
import {
  CapabilityDeniedError,
  type CapabilityProfile,
} from '../../src/lib/permissions/types';

describe('selectorMatches', () => {
  it('exact match', () => {
    expect(selectorMatches('coder', 'coder')).toBe(true);
    expect(selectorMatches('coder', 'coder/sub')).toBe(false);
    expect(selectorMatches('coder', 'other')).toBe(false);
  });

  it('prefix jail p/* matches root and descendants', () => {
    expect(selectorMatches('coder/*', 'coder')).toBe(true);
    expect(selectorMatches('coder/*', 'coder/tasks')).toBe(true);
    expect(selectorMatches('coder/*', 'coder/a/b/c')).toBe(true);
    expect(selectorMatches('coder/*', 'coderx')).toBe(false); // not a path child
    expect(selectorMatches('coder/*', 'other')).toBe(false);
  });

  it('bare-prefix glob p* matches by string prefix', () => {
    expect(selectorMatches('coder', 'coder')).toBe(true);
    expect(selectorMatches('coder*', 'coderx')).toBe(true);
    expect(selectorMatches('coder*', 'coder/tasks')).toBe(true);
    expect(selectorMatches('coder*', 'cod')).toBe(false);
  });

  it('wildcard and deny tokens', () => {
    expect(selectorMatches('*', 'anything')).toBe(true);
    expect(selectorMatches('*', 'coder/x')).toBe(true);
    expect(selectorMatches('none', 'coder')).toBe(false);
    expect(selectorMatches('', 'coder')).toBe(false);
  });

  it('trims whitespace on both sides', () => {
    expect(selectorMatches(' coder/* ', ' coder/tasks ')).toBe(true);
  });
});

const coderJail: CapabilityProfile = {
  name: 'red-coder-jail',
  description: 'Red Coder can only touch its own coder/* data.',
  capabilities: [
    { resource: 'state', actions: ['read', 'write', 'create', 'delete'], selector: 'coder/*' },
    { resource: 'knowledge', actions: ['read', 'write', 'create', 'delete'], selector: 'coder/*' },
  ],
};

describe('decide', () => {
  it('allows in-prefix state write', () => {
    expect(decide(coderJail, 'state', 'write', 'coder/tasks').allowed).toBe(true);
  });

  it('denies cross-prefix state write with a model-readable reason', () => {
    const d = decide(coderJail, 'state', 'write', 'finance/ledger');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('Permission denied');
    expect(d.reason).toContain('coder/*');
  });

  it('empty profile denies everything (fail-closed lockdown)', () => {
    const locked: CapabilityProfile = { name: 'locked', capabilities: [] };
    expect(decide(locked, 'state', 'read', 'coder').allowed).toBe(false);
  });

  it('action scoping is independent (read grant does not imply delete)', () => {
    const readOnly: CapabilityProfile = {
      name: 'ro',
      capabilities: [{ resource: 'state', actions: ['read'], selector: 'coder/*' }],
    };
    expect(decide(readOnly, 'state', 'read', 'coder/x').allowed).toBe(true);
    expect(decide(readOnly, 'state', 'delete', 'coder/x').allowed).toBe(false);
  });
});

describe('enforceToolCapability — backward compat', () => {
  it('unprofiled run is never gated (null profile)', () => {
    expect(() =>
      enforceToolCapability(null, 'delete_namespace', { namespace: 'finance' }),
    ).not.toThrow();
  });

  it('non-data tool is never gated even when profiled', () => {
    expect(() =>
      enforceToolCapability(coderJail, 'web_search', { query: 'anything' }),
    ).not.toThrow();
  });
});

describe('enforceToolCapability — state', () => {
  it('ALLOWS in-prefix state write', () => {
    expect(() =>
      enforceToolCapability(coderJail, 'set_global_state', {
        namespace: 'coder/tasks',
        key: 'k',
        value: 1,
      }),
    ).not.toThrow();
  });

  it('DENIES cross-prefix state write (fail-closed)', () => {
    expect(() =>
      enforceToolCapability(coderJail, 'set_global_state', {
        namespace: 'finance',
        key: 'k',
        value: 1,
      }),
    ).toThrow(CapabilityDeniedError);
  });

  it('DENIES cross-prefix namespace delete', () => {
    expect(() =>
      enforceToolCapability(coderJail, 'delete_namespace', { namespace: 'finance' }),
    ).toThrow(CapabilityDeniedError);
  });

  it('DENIES unscoped list_namespaces without a wildcard grant', () => {
    expect(() =>
      enforceToolCapability(coderJail, 'list_namespaces', {}),
    ).toThrow(CapabilityDeniedError);
  });

  it('ALLOWS unscoped list_namespaces when a wildcard read grant exists', () => {
    const withWildcardRead: CapabilityProfile = {
      name: 'p',
      capabilities: [
        { resource: 'state', actions: ['read'], selector: '*' },
        { resource: 'state', actions: ['write', 'delete'], selector: 'coder/*' },
      ],
    };
    expect(() =>
      enforceToolCapability(withWildcardRead, 'list_namespaces', {}),
    ).not.toThrow();
    // ...but writes outside coder/* are still denied
    expect(() =>
      enforceToolCapability(withWildcardRead, 'set_global_state', {
        namespace: 'finance',
        key: 'k',
        value: 1,
      }),
    ).toThrow(CapabilityDeniedError);
  });
});

describe('enforceToolCapability — knowledge', () => {
  const libJail: CapabilityProfile = {
    name: 'lib-jail',
    capabilities: [
      { resource: 'knowledge', actions: ['read', 'write', 'create', 'delete'], selector: 'coder/*' },
    ],
  };

  it('ALLOWS in-prefix add_document', () => {
    expect(() =>
      enforceToolCapability(libJail, 'add_document', {
        libraryId: 'coder/notes',
        content: 'hi',
      }),
    ).not.toThrow();
  });

  it('DENIES cross-prefix delete_document', () => {
    expect(() =>
      enforceToolCapability(libJail, 'delete_document', {
        libraryId: 'finance/q1',
        documentId: 'd1',
      }),
    ).toThrow(CapabilityDeniedError);
  });

  it('DENIES create_library with an out-of-prefix name', () => {
    expect(() =>
      enforceToolCapability(libJail, 'create_library', { name: 'finance-secrets' }),
    ).toThrow(CapabilityDeniedError);
  });

  it('ALLOWS create_library with an in-prefix name', () => {
    expect(() =>
      enforceToolCapability(libJail, 'create_library', { name: 'coder/scratch' }),
    ).not.toThrow();
  });
});

describe('normalizeProfile', () => {
  it('returns null for non-object / missing capabilities (→ unprofiled)', () => {
    expect(normalizeProfile(null)).toBeNull();
    expect(normalizeProfile('nope')).toBeNull();
    expect(normalizeProfile({ name: 'x' })).toBeNull();
  });

  it('drops invalid grants but keeps valid ones', () => {
    const p = normalizeProfile({
      name: 'p',
      capabilities: [
        { resource: 'state', actions: ['write'], selector: 'coder/*' },
        { resource: 'bogus', actions: ['write'], selector: '*' }, // dropped
        { resource: 'knowledge', actions: [], selector: '*' }, // dropped (no actions)
      ],
    });
    expect(p).not.toBeNull();
    expect(p!.capabilities).toHaveLength(1);
    expect(p!.capabilities[0].resource).toBe('state');
  });

  it('empty capabilities array normalizes to a valid lockdown profile', () => {
    const p = normalizeProfile({ name: 'locked', capabilities: [] });
    expect(p).not.toBeNull();
    expect(p!.capabilities).toHaveLength(0);
  });
});
