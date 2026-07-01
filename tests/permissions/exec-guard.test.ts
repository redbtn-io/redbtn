/**
 * Exec-guard runtime gates (exec-binding Goal 2): kill switch, rate limit,
 * fail-closed-on-audit. Mocks ioredis + fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runExecGuard, ExecBlockedError, isGuardedExecTool, __setRedisForTest } from '../../src/lib/permissions/exec-guard';

// Injected fake redis (no real connection).
const redisState = {
  get: vi.fn(async (_k: string): Promise<string | null> => null),
  incr: vi.fn(async (_k: string): Promise<number> => 1),
  expire: vi.fn(async (_k: string, _s: number): Promise<number> => 1),
};

const ctx: any = { state: { userId: 'u1', authToken: 'tok', runId: 'r1' } };
const okArgs = { environmentId: 'env_ABC', command: 'ls' };

beforeEach(() => {
  redisState.get.mockImplementation(async () => null);
  redisState.incr.mockImplementation(async () => 1);
  redisState.expire.mockImplementation(async () => 1);
  __setRedisForTest(redisState);
  process.env.WEBAPP_URL = 'http://localhost:3000';
  delete process.env.EXEC_AUDIT_FAIL_OPEN;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as Response));
});

describe('isGuardedExecTool', () => {
  it('guards exec/computer tools, not data/unmapped', () => {
    expect(isGuardedExecTool('run_command')).toBe(true);
    expect(isGuardedExecTool('desktop_click')).toBe(true);
    expect(isGuardedExecTool('set_global_state')).toBe(false);
    expect(isGuardedExecTool('web_search')).toBe(false);
  });
});

describe('exec-guard — allow path', () => {
  it('resolves when clean + audit succeeds', async () => {
    await expect(runExecGuard(ctx, 'run_command', okArgs)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('is a no-op for non-guarded tools', async () => {
    await expect(runExecGuard(ctx, 'set_global_state', { namespace: 'x' })).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('exec-guard — kill switch', () => {
  it('DENIES when the global kill flag is set', async () => {
    redisState.get.mockImplementation(async (k: string) => (k === 'exec:kill:global' ? '1' : null));
    await expect(runExecGuard(ctx, 'run_command', okArgs)).rejects.toMatchObject({ code: 'kill_switch' });
  });
  it('DENIES when the per-env kill flag is set', async () => {
    redisState.get.mockImplementation(async (k: string) => (k === 'exec:kill:env:env_ABC' ? '1' : null));
    await expect(runExecGuard(ctx, 'run_command', okArgs)).rejects.toBeInstanceOf(ExecBlockedError);
  });
});

describe('exec-guard — rate limit', () => {
  it('DENIES when the per-user counter exceeds the cap', async () => {
    process.env.EXEC_RATE_MAX = '2';
    redisState.incr.mockImplementation(async () => 3); // over cap
    await expect(runExecGuard(ctx, 'run_command', okArgs)).rejects.toMatchObject({ code: 'rate_limited' });
    delete process.env.EXEC_RATE_MAX;
  });
  it('ALLOWS when under the cap', async () => {
    process.env.EXEC_RATE_MAX = '10';
    redisState.incr.mockImplementation(async () => 1);
    await expect(runExecGuard(ctx, 'run_command', okArgs)).resolves.toBeUndefined();
    delete process.env.EXEC_RATE_MAX;
  });
});

describe('exec-guard — fail-closed on audit (D12)', () => {
  it('DENIES when the audit POST fails (non-ok)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
    await expect(runExecGuard(ctx, 'run_command', okArgs)).rejects.toMatchObject({ code: 'audit_unavailable' });
  });
  it('DENIES when the audit POST throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    await expect(runExecGuard(ctx, 'run_command', okArgs)).rejects.toMatchObject({ code: 'audit_unavailable' });
  });
  it('DENIES when there is no usable auth to audit with', async () => {
    const noAuth: any = { state: { runId: 'r1' } }; // no authToken, no userId
    await expect(runExecGuard(noAuth, 'run_command', okArgs)).rejects.toMatchObject({ code: 'audit_unavailable' });
  });
  it('ALLOWS a failed audit only when EXEC_AUDIT_FAIL_OPEN=true (escape hatch)', async () => {
    process.env.EXEC_AUDIT_FAIL_OPEN = 'true';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
    await expect(runExecGuard(ctx, 'run_command', okArgs)).resolves.toBeUndefined();
    delete process.env.EXEC_AUDIT_FAIL_OPEN;
  });
});

describe('exec-guard — SHADOW mode (Goal 3: log-only migration)', () => {
  beforeEach(() => { process.env.PERMISSIONS_SHADOW = 'true'; });
  afterEach(() => { delete process.env.PERMISSIONS_SHADOW; });

  it('ALLOWS through when the rate limit is exceeded (log-only)', async () => {
    process.env.EXEC_RATE_MAX = '2';
    redisState.incr.mockImplementation(async () => 99); // way over
    await expect(runExecGuard(ctx, 'run_command', okArgs)).resolves.toBeUndefined();
    delete process.env.EXEC_RATE_MAX;
  });
  it('ALLOWS through when the audit is unavailable (log-only)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
    await expect(runExecGuard(ctx, 'run_command', okArgs)).resolves.toBeUndefined();
  });
  it('STILL DENIES on an explicit kill switch (not relaxed by shadow)', async () => {
    redisState.get.mockImplementation(async (k: string) => (k === 'exec:kill:global' ? '1' : null));
    await expect(runExecGuard(ctx, 'run_command', okArgs)).rejects.toMatchObject({ code: 'kill_switch' });
  });
});
