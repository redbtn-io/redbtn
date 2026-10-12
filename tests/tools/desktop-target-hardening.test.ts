/**
 * Desktop target resolution only reaches the address the capability gate
 * checked (2026-10-12 hardening, found by the redOps agent).
 *
 * The gate checks `environmentId || machine`. The resolver used to fall back
 * to a FUZZY `machine` lookup (installId prefix, name substring) when the
 * environmentId failed to resolve, and to fuzzy-match a bare machine name —
 * so a call could land on a different desktop than the one a scoped grant
 * named. Now:
 *   - environmentId given: resolve it only; never fall back; refuse when
 *     `machine` names a different desktop;
 *   - machine only: exact environmentId / installId / name (case-insensitive)
 *     under a scoped grant; fuzzy lookup only for '*' grants / unprofiled /
 *     ungated tools.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const requestDesktopMock = vi.hoisted(() => vi.fn());
const requestDesktopRawMock = vi.hoisted(() => vi.fn());
const loadAndResolveEnvironmentMock = vi.hoisted(() => vi.fn());
const envDocs = vi.hoisted(() => ({ list: [] as any[], lastQuery: null as any }));

vi.mock('../../src/lib/tools/native/desktop-request', () => ({
  requestDesktop: requestDesktopMock,
  requestDesktopRaw: requestDesktopRawMock,
}));
vi.mock('../../src/lib/environments/loadAndResolveEnvironment', () => ({
  loadAndResolveEnvironment: loadAndResolveEnvironmentMock,
}));
vi.mock('mongoose', async (orig) => {
  const m: any = await orig();
  const db = {
    collection: () => ({
      find: (q: any) => {
        envDocs.lastQuery = q;
        const ors: any[] = q.$or ?? [];
        const docs = envDocs.list.filter((d) =>
          ors.some((o) =>
            Object.entries(o).some(([k, v]: [string, any]) => {
              const val = d[k];
              if (typeof v === 'string') return val === v;
              if (v && v.$regex) return typeof val === 'string' && new RegExp(v.$regex, v.$options).test(val);
              return false;
            }),
          ),
        );
        return { toArray: async () => docs };
      },
    }),
  };
  const mongoose = { ...m.default, connection: { db, readyState: 1 } };
  return { ...m, default: mongoose, connection: mongoose.connection };
});

import { desktopClick, desktopExec, desktopPing } from '../../src/lib/tools/native/desktop-computer';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import type { CapabilityProfile } from '../../src/lib/permissions/types';

const RUN = 'run_desktop_harden';

function ctx(): any {
  return { publisher: { emit: vi.fn() }, state: { userId: 'user_a', runId: RUN }, runId: RUN, nodeId: 'n', toolId: 't', abortSignal: null };
}

function body(r: any) {
  const b = r.content.find((c: any) => c.type === 'text');
  return JSON.parse(b.text);
}

beforeEach(() => {
  requestDesktopMock.mockReset();
  requestDesktopRawMock.mockReset();
  loadAndResolveEnvironmentMock.mockReset();
  requestDesktopMock.mockResolvedValue({ kind: 'computer_result', id: 'r', ok: true });
  requestDesktopRawMock.mockResolvedValue({ ok: true, result: { stdout: '', stderr: '', exitCode: 0 } });
  envDocs.list = [
    { environmentId: 'env_alpha_ws', installId: '4f8dee9e-c852-446a-a1e6-76ddfc9023db', name: 'alphaWorkstation', userId: 'user_a', kind: 'desktop-agent' },
    { environmentId: 'env_alpha_sys', installId: '99935018-5750-4894-9829-90a93cc5fc61', name: 'alphaSystem', userId: 'user_a', kind: 'desktop-agent' },
  ];
});
afterEach(() => runControlRegistry.unregister(RUN));

describe('environmentId given', () => {
  test('a failed environmentId never falls back to machine', async () => {
    runControlRegistry.register(RUN, 'w');
    loadAndResolveEnvironmentMock.mockRejectedValue(new Error('not found'));
    const r = await desktopClick.handler({ environmentId: 'env_missing', machine: 'alphaSystem', x: 1, y: 1 }, ctx());
    expect(JSON.stringify(body(r))).toMatch(/Failed to resolve environment env_missing/);
    expect(requestDesktopMock).not.toHaveBeenCalled();
  });

  test('environmentId and a machine naming a different desktop are refused', async () => {
    runControlRegistry.register(RUN, 'w');
    loadAndResolveEnvironmentMock.mockResolvedValue({ env: { environmentId: 'env_alpha_sys', installId: '99935018-5750-4894-9829-90a93cc5fc61', name: 'alphaSystem' } });
    const r = await desktopClick.handler({ environmentId: 'env_alpha_sys', machine: 'alphaWorkstation', x: 1, y: 1 }, ctx());
    expect(JSON.stringify(body(r))).toMatch(/name different desktops/);
    expect(requestDesktopMock).not.toHaveBeenCalled();
    // agreeing machine (its name) is fine
    const ok = await desktopClick.handler({ environmentId: 'env_alpha_sys', machine: 'ALPHASYSTEM', x: 1, y: 1 }, ctx());
    expect(body(ok).ok).toBe(true);
  });
});

describe('machine only', () => {
  const scoped: CapabilityProfile = { name: 's', capabilities: [{ resource: 'computer', actions: ['control'], selector: 'alpha' }] };
  const star: CapabilityProfile = { name: 'w', capabilities: [{ resource: 'computer', actions: ['control'], selector: '*' }] };

  test('under a scoped grant, "alpha" must name a desktop exactly — no substring match onto alphaWorkstation', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: scoped });
    envDocs.list.push({ environmentId: 'env_x', installId: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'alphaWorkstation2', userId: 'user_a', kind: 'desktop-agent' });
    envDocs.list = envDocs.list.filter((d) => d.name !== 'alphaSystem' && d.name !== 'alphaWorkstation2');
    loadAndResolveEnvironmentMock.mockRejectedValue(new Error('not found'));
    const r = await desktopClick.handler({ machine: 'alpha', x: 1, y: 1 }, ctx());
    expect(body(r).error.message).toMatch(/named exactly "alpha"|Failed to resolve desktop/);
    expect(requestDesktopMock).not.toHaveBeenCalled();
    // the exact name works
    const ok = await desktopClick.handler({ machine: 'alphaworkstation', x: 1, y: 1 }, ctx());
    expect(body(ok).ok).toBe(true);
  });

  test("a '*' grant keeps the fuzzy lookup (prefix / substring)", async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: star });
    envDocs.list = envDocs.list.filter((d) => d.name === 'alphaWorkstation');
    const r = await desktopClick.handler({ machine: 'alpha', x: 1, y: 1 }, ctx());
    expect(body(r).ok).toBe(true);
    expect(JSON.stringify(envDocs.lastQuery)).toMatch(/\$regex/);
  });

  test('desktop_exec is judged against exec grants', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: { name: 'e', capabilities: [{ resource: 'exec', actions: ['execute'], selector: 'alphaSystem' }] } });
    loadAndResolveEnvironmentMock.mockRejectedValue(new Error('not found'));
    await desktopExec.handler({ machine: 'alphaSys', command: 'ls' }, ctx());
    expect(requestDesktopRawMock).not.toHaveBeenCalled();
    expect(JSON.stringify(envDocs.lastQuery)).not.toMatch(/installId":\{"\$regex/);
  });

  test('ungated tools (desktop_ping) keep the fuzzy lookup', async () => {
    runControlRegistry.register(RUN, 'w', { capabilityProfile: scoped });
    envDocs.list = envDocs.list.filter((d) => d.name === 'alphaWorkstation');
    await desktopPing.handler({ machine: 'alphaW' }, ctx());
    expect(JSON.stringify(envDocs.lastQuery)).toMatch(/\$regex/);
  });
});
