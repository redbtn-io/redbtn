/**
 * Exec-guard runtime gates (exec-binding Goal 2): kill switch, rate limit,
 * fail-closed-on-audit. Mocks ioredis + fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runExecGuard, ExecBlockedError, isGuardedExecTool, auditAttempt, __setRedisForTest } from '../../src/lib/permissions/exec-guard';

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

// ── Engine (worker) run context: durable-audit authenticates as a SERVICE
// PRINCIPAL ──────────────────────────────────────────────────────────────────
// A worker/engine run carries NO user Bearer token; it authenticates to the
// webapp audit sink as a service principal (X-Internal-Key + X-User-Id), exactly
// like the native state tools. This is the path EVERY Red Ops run takes (shared
// principal 69a0b790a0ae8660290a78da). If it did not authenticate, auditAttempt
// would return false and — at shadow-off — Gate 7 (fail-closed audit) would DENY
// all Red Ops exec fleet-wide. These tests pin that the engine context DOES
// authenticate, and pin the exact conditions under which it (deliberately) cannot.
// See docs/redops-exec-guard-readiness.md §3.
describe('exec-guard — engine run context audits as a service principal', () => {
  const RED_OPS_PRINCIPAL = '69a0b790a0ae8660290a78da';
  // Representative worker/engine context: a userId + run identity, NO Bearer token.
  const engineCtx: any = { state: { userId: RED_OPS_PRINCIPAL, runId: 'run_x', graphId: 'tHXXSTFtOuM9' } };

  afterEach(() => { delete process.env.INTERNAL_SERVICE_KEY; });

  it('auditAttempt returns true and sends X-Internal-Key + X-User-Id (no Bearer)', async () => {
    process.env.INTERNAL_SERVICE_KEY = 'svc-key';
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true } as Response;
    }));

    const ok = await auditAttempt(engineCtx, 'run_command', 'exec', 'execute', '*', 'allowed');

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/v1/permissions/exec-attempts');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Internal-Key']).toBe('svc-key');
    expect(headers['X-User-Id']).toBe(RED_OPS_PRINCIPAL);
    expect(headers['Authorization']).toBeUndefined(); // worker runs carry NO Bearer
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.graphId).toBe('tHXXSTFtOuM9'); // run identity threaded from state
    expect(body.outcome).toBe('allowed');
  });

  it('auditAttempt returns false and never POSTs when neither a Bearer nor an internal key is present (fail-closed trigger)', async () => {
    delete process.env.INTERNAL_SERVICE_KEY; // no service credential…
    // …and engineCtx carries no authToken → canAuth is false → cannot durably persist.
    const ok = await auditAttempt(engineCtx, 'run_command', 'exec', 'execute', '*', 'allowed');
    expect(ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled(); // never POST an unauthenticated audit
  });

  it('runExecGuard ALLOWS a Red Ops engine run end-to-end (Gate 7 audit succeeds via service principal)', async () => {
    process.env.INTERNAL_SERVICE_KEY = 'svc-key';
    redisState.incr.mockImplementation(async () => 1); // under the rate cap
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as Response));
    await expect(runExecGuard(engineCtx, 'run_command', { command: 'ls' })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('runExecGuard DENIES a Red Ops engine run (audit_unavailable) when the service credential is missing, shadow OFF', async () => {
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.PERMISSIONS_SHADOW;
    redisState.incr.mockImplementation(async () => 1); // under the rate cap — isolate the audit gate
    await expect(runExecGuard(engineCtx, 'run_command', { command: 'ls' })).rejects.toMatchObject({ code: 'audit_unavailable' });
  });
});
