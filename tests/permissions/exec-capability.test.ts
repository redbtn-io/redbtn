/**
 * exec/computer capability layer — fail-closed unit tests (exec-binding Goal 1).
 *
 * Verifies the LOCKED decisions:
 *  - exec/computer are FAIL-CLOSED: denied when unprofiled, and denied when a
 *    profile grants only data (state/knowledge).
 *  - data (state/knowledge) stays FAIL-OPEN / back-compat.
 *  - an explicit exec grant scoped to an environmentId allows that env only;
 *    unscoped exec (no environmentId) needs a '*' grant.
 *  - normalizeProfile keeps exec/computer grants (doesn't drop them).
 *
 * Pure logic — no run context, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { enforceToolCapability, normalizeProfile } from '../../src/lib/permissions/enforce';
import { isGuardedExecTool } from '../../src/lib/permissions/exec-guard';
import { CapabilityDeniedError, type CapabilityProfile } from '../../src/lib/permissions/types';

const ENV = 'env_ABC';
const OTHER = 'env_XYZ';

const dataOnlyJail: CapabilityProfile = {
  name: 'data-only',
  capabilities: [
    { resource: 'state', actions: ['read', 'write', 'create', 'delete'], selector: 'coder/*' },
    { resource: 'knowledge', actions: ['read', 'write', 'create'], selector: 'coder*' },
  ],
};
const execScoped: CapabilityProfile = {
  name: 'exec-scoped',
  capabilities: [{ resource: 'exec', actions: ['execute'], selector: ENV }],
};
const execWildcard: CapabilityProfile = {
  name: 'exec-wild',
  capabilities: [{ resource: 'exec', actions: ['execute'], selector: '*' }],
};
const computerScoped: CapabilityProfile = {
  name: 'computer-scoped',
  capabilities: [{ resource: 'computer', actions: ['control'], selector: ENV }],
};

describe('exec/computer — FAIL-CLOSED when unprofiled', () => {
  it('DENIES run_command with no profile (fail-closed)', () => {
    expect(() => enforceToolCapability(null, 'run_command', { environmentId: ENV, command: 'ls' }))
      .toThrow(CapabilityDeniedError);
  });
  it('DENIES ssh_shell / ssh_copy / read_file / desktop_exec with no profile', () => {
    for (const t of ['ssh_shell', 'ssh_copy', 'read_file', 'desktop_exec']) {
      expect(() => enforceToolCapability(null, t, { environmentId: ENV, command: 'x', path: '/x' }))
        .toThrow(CapabilityDeniedError);
    }
  });
  // Regression (capability-jail bypass): the environment fs-pack + async-exec
  // tools MUTATE the remote filesystem (write_file/edit_file) or run arbitrary
  // SSH commands (glob/grep_files/ssh_run_async) — strictly higher risk than the
  // already-gated read-only read_file — yet were unmapped, so an UNPROFILED run
  // (fail-closed) and a jailed run could both reach them ungated. They must be
  // fail-closed exactly like ssh_shell/read_file.
  it('DENIES fs-pack + async-exec env tools with no profile (fail-closed)', () => {
    for (const t of ['write_file', 'edit_file', 'glob', 'grep_files', 'ssh_run_async', 'ssh_tail', 'ssh_kill', 'ssh_jobs']) {
      expect(() => enforceToolCapability(null, t, { environmentId: ENV, command: 'x', path: '/x', jobId: 'j', pattern: '*' }))
        .toThrow(CapabilityDeniedError);
    }
  });
  it('DENIES desktop computer-use tools with no profile', () => {
    for (const t of ['desktop_screenshot', 'desktop_click', 'desktop_type', 'desktop_key']) {
      expect(() => enforceToolCapability(null, t, { environmentId: ENV }))
        .toThrow(CapabilityDeniedError);
    }
  });
});

describe('data — stays FAIL-OPEN when unprofiled (back-compat)', () => {
  it('ALLOWS state/knowledge with no profile', () => {
    expect(() => enforceToolCapability(null, 'set_global_state', { namespace: 'finance' })).not.toThrow();
    expect(() => enforceToolCapability(null, 'delete_namespace', { namespace: 'finance' })).not.toThrow();
    expect(() => enforceToolCapability(null, 'add_document', { libraryId: 'lib1' })).not.toThrow();
  });
  it('leaves unmapped tools ungated with no profile', () => {
    expect(() => enforceToolCapability(null, 'web_search', { query: 'x' })).not.toThrow();
  });
});

describe('exec/computer — DENIED by a data-only profile', () => {
  it('DENIES run_command when the profile grants only state/knowledge', () => {
    expect(() => enforceToolCapability(dataOnlyJail, 'run_command', { environmentId: ENV, command: 'ls' }))
      .toThrow(CapabilityDeniedError);
  });
  it('DENIES desktop_screenshot under a data-only profile', () => {
    expect(() => enforceToolCapability(dataOnlyJail, 'desktop_screenshot', { environmentId: ENV }))
      .toThrow(CapabilityDeniedError);
  });
  it('still ALLOWS in-jail state under the data-only profile', () => {
    expect(() => enforceToolCapability(dataOnlyJail, 'set_global_state', { namespace: 'coder/build' }))
      .not.toThrow();
  });
});

describe('exec — scoped grant', () => {
  it('ALLOWS run_command on the granted env', () => {
    expect(() => enforceToolCapability(execScoped, 'run_command', { environmentId: ENV, command: 'ls' }))
      .not.toThrow();
  });
  it('DENIES run_command on a DIFFERENT env', () => {
    expect(() => enforceToolCapability(execScoped, 'run_command', { environmentId: OTHER, command: 'ls' }))
      .toThrow(CapabilityDeniedError);
  });
  it('DENIES read_file on a different env; ALLOWS on the granted env', () => {
    expect(() => enforceToolCapability(execScoped, 'read_file', { environmentId: OTHER, path: '/x' }))
      .toThrow(CapabilityDeniedError);
    expect(() => enforceToolCapability(execScoped, 'read_file', { environmentId: ENV, path: '/x' }))
      .not.toThrow();
  });
  // The bypass this fix closes: a run jailed to ENV must NOT be able to WRITE a
  // file or run an async command on a DIFFERENT env — and CAN on the granted one.
  it('jails write_file / edit_file / ssh_run_async to the granted env only', () => {
    for (const t of ['write_file', 'edit_file', 'glob', 'grep_files', 'ssh_run_async']) {
      expect(() => enforceToolCapability(execScoped, t, { environmentId: OTHER, path: '/x', content: 'y', oldString: 'a', newString: 'b', command: 'rm -rf /', pattern: '*' }))
        .toThrow(CapabilityDeniedError);
      expect(() => enforceToolCapability(execScoped, t, { environmentId: ENV, path: '/x', content: 'y', oldString: 'a', newString: 'b', command: 'ls', pattern: '*' }))
        .not.toThrow();
    }
  });
  it('DENIES fs-pack write/exec under a data-only jail', () => {
    for (const t of ['write_file', 'edit_file', 'ssh_run_async']) {
      expect(() => enforceToolCapability(dataOnlyJail, t, { environmentId: ENV, path: '/x', content: 'y', command: 'ls' }))
        .toThrow(CapabilityDeniedError);
    }
  });
});

describe('exec — unscoped (inline ssh_shell / no environmentId) requires wildcard', () => {
  it('DENIES unscoped exec under a per-env grant (prefix/exact ≠ wildcard)', () => {
    expect(() => enforceToolCapability(execScoped, 'ssh_shell', { command: 'ls' /* no environmentId */ }))
      .toThrow(CapabilityDeniedError);
  });
  it('ALLOWS unscoped exec only under a true "*" grant', () => {
    expect(() => enforceToolCapability(execWildcard, 'ssh_shell', { command: 'ls' })).not.toThrow();
    // and wildcard also allows any specific env
    expect(() => enforceToolCapability(execWildcard, 'run_command', { environmentId: OTHER, command: 'ls' }))
      .not.toThrow();
  });
});

describe('computer — scoped grant', () => {
  it('ALLOWS desktop_click on the granted env, DENIES on another', () => {
    expect(() => enforceToolCapability(computerScoped, 'desktop_click', { environmentId: ENV })).not.toThrow();
    expect(() => enforceToolCapability(computerScoped, 'desktop_click', { environmentId: OTHER }))
      .toThrow(CapabilityDeniedError);
  });
  it('a computer grant does NOT satisfy exec', () => {
    expect(() => enforceToolCapability(computerScoped, 'run_command', { environmentId: ENV, command: 'ls' }))
      .toThrow(CapabilityDeniedError);
  });
});

describe('runtime exec-guard also covers the fs-pack + async-exec tools', () => {
  // The kill switch / rate limit / fail-closed audit in exec-guard.ts key off the
  // SAME tool-map (isGuardedExecTool → getDataToolRule + isFailClosedResource). If
  // these tools are dropped from the map they silently lose that layer too, so
  // assert coverage here — this test fails if the fix is reverted.
  it('treats every environment write/exec tool as a guarded exec tool', () => {
    for (const t of ['write_file', 'edit_file', 'glob', 'grep_files', 'ssh_run_async', 'ssh_tail', 'ssh_kill', 'ssh_jobs']) {
      expect(isGuardedExecTool(t), `${t} must be a guarded exec tool`).toBe(true);
    }
  });
});

describe('normalizeProfile — keeps exec/computer grants', () => {
  it('preserves exec:execute and computer:control (does not drop them)', () => {
    const p = normalizeProfile({
      name: 'p',
      capabilities: [
        { resource: 'exec', actions: ['execute'], selector: ENV },
        { resource: 'computer', actions: ['control'], selector: '*' },
        { resource: 'state', actions: ['read'], selector: 'coder/*' },
      ],
    });
    expect(p).not.toBeNull();
    expect(p!.capabilities.map((c) => c.resource).sort()).toEqual(['computer', 'exec', 'state']);
    const exec = p!.capabilities.find((c) => c.resource === 'exec')!;
    expect(exec.actions).toEqual(['execute']);
  });
  it('drops unknown resources/actions but keeps valid ones', () => {
    const p = normalizeProfile({
      name: 'p',
      capabilities: [
        { resource: 'bogus', actions: ['execute'], selector: '*' },
        { resource: 'exec', actions: ['nope', 'execute'], selector: ENV },
      ],
    });
    expect(p!.capabilities).toHaveLength(1);
    expect(p!.capabilities[0].resource).toBe('exec');
    expect(p!.capabilities[0].actions).toEqual(['execute']);
  });
});
