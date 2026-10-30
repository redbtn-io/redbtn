/**
 * browser capability layer — fail-closed unit tests (redbtn Browser extension).
 *
 * Verifies:
 *  - EVERY browser_* native is mapped in DATA_TOOL_RULES under the `browser`
 *    resource (an unmapped tool is ungated — it short-circuits to "allow" in
 *    enforce.ts and skips the exec guard).
 *  - Senses map to verbs: See = read, Control = control, Exec = execute
 *    (browser_evaluate only). browser_tabs is dynamic: read for op 'list',
 *    control for open/close/activate.
 *  - `browser` is FAIL-CLOSED: denied with no profile, like exec/computer.
 *  - Scoped grants jail a run to specific browser environmentIds, and the
 *    exec guard (kill switch / rate / audit) covers browser tools.
 *
 * Pure logic — no run context, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { enforceToolCapability, normalizeProfile } from '../../src/lib/permissions/enforce';
import { DATA_TOOL_RULES, getDataToolRule } from '../../src/lib/permissions/tool-map';
import { isGuardedExecTool } from '../../src/lib/permissions/exec-guard';
import { CapabilityDeniedError, type CapabilityProfile } from '../../src/lib/permissions/types';

/** Canonical browser_* native list — every one must be capability-mapped. */
const BROWSER_TOOLS = [
  'browser_list',
  'browser_tabs',
  'browser_snapshot',
  'browser_read',
  'browser_screenshot',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_hover',
  'browser_scroll',
  'browser_select',
  'browser_fill_form',
  'browser_wait_for',
  'browser_dialog',
  'browser_evaluate',
  'browser_console',
  'browser_network',
  'browser_upload',
  'browser_acquire_lock',
  'browser_release_lock',
] as const;

const SEE_TOOLS = ['browser_snapshot', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_network'];
const CONTROL_TOOLS = [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_hover',
  'browser_scroll',
  'browser_select',
  'browser_fill_form',
  'browser_wait_for',
  'browser_dialog',
  'browser_upload',
  'browser_acquire_lock',
  'browser_release_lock',
];

describe('browser — every browser_* tool is mapped to the browser resource', () => {
  it('maps the full canonical list', () => {
    for (const t of BROWSER_TOOLS) {
      const rule = getDataToolRule(t);
      expect(rule, `${t} must be in DATA_TOOL_RULES`).toBeDefined();
      expect(rule?.resource, `${t} resource`).toBe('browser');
      expect(DATA_TOOL_RULES[t]?.resource).toBe('browser');
    }
  });
});

describe('browser — senses map to verbs (See=read, Control=control, Exec=execute)', () => {
  it('See tools resolve to read', () => {
    for (const t of SEE_TOOLS) {
      expect(getDataToolRule(t)?.action, t).toBe('read');
    }
    expect(getDataToolRule('browser_list')?.action).toBe('read');
  });
  it('Control tools resolve to control', () => {
    for (const t of CONTROL_TOOLS) {
      expect(getDataToolRule(t)?.action, t).toBe('control');
    }
  });
  it('browser_evaluate is the only execute (Exec) tool', () => {
    expect(getDataToolRule('browser_evaluate')?.action).toBe('execute');
    for (const t of BROWSER_TOOLS) {
      if (t === 'browser_evaluate') continue;
      expect(getDataToolRule(t)?.action, t).not.toBe('execute');
    }
  });
  it("browser_tabs is dynamic: 'list'/missing = read (See), open = control", () => {
    const rule = getDataToolRule('browser_tabs');
    expect(rule?.actionFor).toBeDefined();
    expect(rule?.actionFor?.({ action: 'list' })).toBe('read');
    expect(rule?.actionFor?.({})).toBe('read');
    expect(rule?.actionFor?.({ action: 'open' })).toBe('control');
    expect(rule?.actionFor?.({ action: 'close' })).toBe('control');
    expect(rule?.actionFor?.({ action: 'activate' })).toBe('control');
  });
});

describe('browser — FAIL-CLOSED when unprofiled', () => {
  it('DENIES browser_snapshot / browser_click / browser_evaluate with no profile', () => {
    expect(() => enforceToolCapability(null, 'browser_snapshot', { browser: 'env_B' }))
      .toThrow(CapabilityDeniedError);
    expect(() => enforceToolCapability(null, 'browser_click', { browser: 'env_B' }))
      .toThrow(CapabilityDeniedError);
    expect(() => enforceToolCapability(null, 'browser_evaluate', { browser: 'env_B' }))
      .toThrow(CapabilityDeniedError);
  });
  it('DENIES every browser_* tool with no profile', () => {
    for (const t of BROWSER_TOOLS) {
      expect(() => enforceToolCapability(null, t, { browser: 'env_B', action: 'list' }), t)
        .toThrow(CapabilityDeniedError);
    }
  });
});

describe('browser — see-only profile', () => {
  const seeOnly: CapabilityProfile = {
    name: 'see-only',
    capabilities: [{ resource: 'browser', actions: ['read'], selector: '*' }],
  };
  it('ALLOWS browser_snapshot on any browser', () => {
    expect(() => enforceToolCapability(seeOnly, 'browser_snapshot', { browser: 'anything' })).not.toThrow();
  });
  it('DENIES browser_click (Control not granted)', () => {
    expect(() => enforceToolCapability(seeOnly, 'browser_click', { browser: 'anything' }))
      .toThrow(CapabilityDeniedError);
  });
  it('DENIES browser_evaluate (Exec not granted)', () => {
    expect(() => enforceToolCapability(seeOnly, 'browser_evaluate', { browser: 'anything' }))
      .toThrow(CapabilityDeniedError);
  });
  it("ALLOWS browser_tabs list, DENIES browser_tabs open (dynamic action)", () => {
    expect(() => enforceToolCapability(seeOnly, 'browser_tabs', { action: 'list', browser: 'x' })).not.toThrow();
    expect(() => enforceToolCapability(seeOnly, 'browser_tabs', { action: 'open', browser: 'x' }))
      .toThrow(CapabilityDeniedError);
  });
});

describe('browser — scoped grant jails to one environment', () => {
  const scoped: CapabilityProfile = {
    name: 'browser-scoped',
    capabilities: [{ resource: 'browser', actions: ['control'], selector: 'env_B' }],
  };
  it('ALLOWS browser_click on the granted env (via environmentId)', () => {
    expect(() => enforceToolCapability(scoped, 'browser_click', { environmentId: 'env_B' })).not.toThrow();
  });
  it('ALLOWS browser_click on the granted env (via browser arg)', () => {
    expect(() => enforceToolCapability(scoped, 'browser_click', { browser: 'env_B' })).not.toThrow();
  });
  it('DENIES browser_click on a different env', () => {
    expect(() => enforceToolCapability(scoped, 'browser_click', { environmentId: 'env_X' }))
      .toThrow(CapabilityDeniedError);
  });
});

describe('browser — profile plumbing', () => {
  it('normalizeProfile keeps a browser grant', () => {
    const p = normalizeProfile({
      name: 'see-only',
      capabilities: [{ resource: 'browser', actions: ['read'], selector: '*' }],
    });
    expect(p).not.toBeNull();
    expect(p?.capabilities).toContainEqual({ resource: 'browser', actions: ['read'], selector: '*' });
  });
  it('browser tools are covered by the exec guard (kill switch / rate / audit)', () => {
    expect(isGuardedExecTool('browser_click')).toBe(true);
    expect(isGuardedExecTool('browser_snapshot')).toBe(true);
    expect(isGuardedExecTool('browser_evaluate')).toBe(true);
  });
});
