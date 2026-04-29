/**
 * Integration test for the native process pack (Env Phase D).
 *
 * Per ENVIRONMENT-HANDOFF.md §6.1 — "process pack: start a `sleep 30`, tail
 * output, kill it, verify cleanup."
 *
 * The four tools form a coherent fire-and-forget lifecycle:
 *
 *    1. ssh_run_async  — start `sleep 30` in the background, get jobId+pid
 *    2. ssh_tail       — read stdout/stderr tail + isRunning status
 *    3. ssh_kill       — send TERM, observe processWasRunning=true
 *    4. ssh_jobs       — enumerate; the killed job appears with status='killed'
 *    5. ssh_tail again — observe status flip to 'killed' (or 'exited' after
 *                         the wrapper writes the exit-code file)
 *
 * Validates:
 *   - All four tools registered in the NativeToolRegistry singleton
 *   - All four share the `system` server label
 *   - Wrapper command + composite read script + kill script are well-formed
 *   - Per-environment Redis hash transitions: running → killed across calls
 *   - Job IDs survive across calls (the PID lookup works on second tail)
 *
 * # Mocking strategy
 *
 * - `loadAndResolveEnvironment` is mocked (no Mongo / redsecrets).
 * - `environmentManager.acquire` returns a stub session whose `exec` is
 *   driven by a queue of canned responses — each call dequeues the next
 *   mock response and (optionally) records the issued command for assertions.
 * - The shared in-memory Redis stub is used across all four tools.
 *
 * Why mock the SSH layer instead of using a real env: the EnvironmentSession
 * itself is exhaustively tested in tests/environments/, so here we want to
 * verify the pack composes cleanly. A real SSH integration would add value
 * but at the cost of needing alpha-server availability, which makes the
 * suite flaky.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';

// ---------------------------------------------------------------------------
// Mock the env-resolution + manager layers BEFORE importing the tools so the
// tools see the mocked symbols at module-evaluation time.
// ---------------------------------------------------------------------------

vi.mock('../../src/lib/environments/loadAndResolveEnvironment', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/loadAndResolveEnvironment')>(
    '../../src/lib/environments/loadAndResolveEnvironment',
  );
  return {
    ...actual,
    loadAndResolveEnvironment: vi.fn(),
  };
});

vi.mock('../../src/lib/environments/EnvironmentManager', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/EnvironmentManager')>(
    '../../src/lib/environments/EnvironmentManager',
  );
  return {
    ...actual,
    environmentManager: { acquire: vi.fn() },
  };
});

import sshRunAsyncTool, {
  __setRedisClientForTests,
  jobsHashKey,
  type AsyncJobMetadata,
} from '../../src/lib/tools/native/ssh-run-async';
import sshTailTool from '../../src/lib/tools/native/ssh-tail';
import sshKillTool from '../../src/lib/tools/native/ssh-kill';
import sshJobsTool from '../../src/lib/tools/native/ssh-jobs';
import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';

// ---------------------------------------------------------------------------
// In-memory Redis stub
// ---------------------------------------------------------------------------

function makeFakeRedis() {
  const data = new Map<string, Map<string, string>>();
  const fake = {
    data,
    async hset(key: string, field: string, value: string) {
      let h = data.get(key);
      if (!h) { h = new Map(); data.set(key, h); }
      h.set(field, value);
      return 1;
    },
    async hget(key: string, field: string) { return data.get(key)?.get(field) ?? null; },
    async hgetall(key: string) {
      const h = data.get(key);
      return h ? Object.fromEntries(h.entries()) : {};
    },
    async expire() { return 1; },
    pipeline() {
      const ops: Array<() => Promise<void>> = [];
      const p = {
        hset(key: string, field: string, value: string) {
          ops.push(async () => { await fake.hset(key, field, value); });
          return p;
        },
        expire(_key: string, _ttl: number) { return p; },
        async exec() { for (const op of ops) await op(); },
      };
      return p;
    },
    on() { /* noop */ },
  };
  return fake;
}

// ---------------------------------------------------------------------------
// Mock SSH session — queue-driven exec
// ---------------------------------------------------------------------------

interface MockExecResponse {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}

class MockSession {
  /** FIFO queue — each exec() pops the next response. */
  responses: MockExecResponse[] = [];
  /** Recorded commands in the order they were exec'd. */
  execCalls: string[] = [];
  /** Optional per-call hook the test can swap in for ad-hoc behaviour. */
  onExec: ((cmd: string) => MockExecResponse | Promise<MockExecResponse>) | null = null;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async exec(cmd: string, _opts?: unknown): Promise<{
    stdout: string; stderr: string; exitCode: number | null; durationMs: number; truncated: boolean;
  }> {
    this.execCalls.push(cmd);
    let next: MockExecResponse;
    if (this.onExec) {
      next = await this.onExec(cmd);
    } else {
      const queued = this.responses.shift();
      if (!queued) throw new Error(`MockSession: no canned response for: ${cmd.substring(0, 80)}`);
      next = queued;
    }
    return {
      stdout: next.stdout,
      stderr: next.stderr ?? '',
      exitCode: next.exitCode ?? 0,
      durationMs: 1,
      truncated: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-int' },
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

const FAKE_ENV = {
  environmentId: 'env_proc_int',
  userId: 'user-int',
  name: 'proc int env',
  kind: 'self-hosted' as const,
  host: '127.0.0.1',
  port: 22,
  user: 'tester',
  secretRef: 'KEY',
  workingDir: '/tmp',
  idleTimeoutMs: 5000,
  maxLifetimeMs: 60000,
  reconnect: { maxAttempts: 3, backoffMs: 50, maxBackoffMs: 500 },
  archiveOutputLogs: false,
  isPublic: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Build a composite-stdout buffer the way the remote `printf` would emit it.
 */
function buildCompositeOutput(opts: {
  stdout: string;
  stderr: string;
  alive: '0' | '1';
  exit: string;
}): string {
  const TAG_STDERR = '\0\0STDERR\0\0';
  const TAG_ALIVE = '\0\0ALIVE\0\0';
  const TAG_EXIT = '\0\0EXIT\0\0';
  return [
    opts.stdout,
    TAG_STDERR,
    opts.stderr,
    TAG_ALIVE,
    opts.alive + '\n',
    TAG_EXIT,
    opts.exit + '\n',
  ].join('');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('process pack integration — registration + chained execution', () => {
  beforeAll(() => {
    // Replicate the registry behavior — under vitest the registry's require()
    // calls fail because the .js paths don't exist. Register the TS modules
    // explicitly so listTools() / has() succeed.
    const registry = getNativeRegistry();
    if (!registry.has('ssh_run_async')) registry.register('ssh_run_async', sshRunAsyncTool);
    if (!registry.has('ssh_tail')) registry.register('ssh_tail', sshTailTool);
    if (!registry.has('ssh_kill')) registry.register('ssh_kill', sshKillTool);
    if (!registry.has('ssh_jobs')) registry.register('ssh_jobs', sshJobsTool);
  });

  test('NativeToolRegistry has all four process-pack tools registered', () => {
    const registry = getNativeRegistry();
    for (const name of ['ssh_run_async', 'ssh_tail', 'ssh_kill', 'ssh_jobs']) {
      expect(registry.has(name)).toBe(true);
      expect(registry.get(name)?.server).toBe('system');
    }
    const all = registry.listTools().map((t) => t.name);
    expect(all).toContain('ssh_run_async');
    expect(all).toContain('ssh_tail');
    expect(all).toContain('ssh_kill');
    expect(all).toContain('ssh_jobs');
  });

  // ── End-to-end chained scenario ──────────────────────────────────────────

  describe('chain: start → tail → kill → list → tail again', () => {
    let fake: ReturnType<typeof makeFakeRedis>;
    let session: MockSession;

    beforeEach(() => {
      fake = makeFakeRedis();
      __setRedisClientForTests(fake);
      session = new MockSession();
      vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(environmentManager.acquire).mockResolvedValue(session as any);
    });

    afterEach(() => {
      vi.clearAllMocks();
      __setRedisClientForTests(null);
    });

    test('full lifecycle: sleep 30 → tail → kill → jobs → tail (status converges)', async () => {
      const ctx = makeMockContext();

      // ── Step 1: ssh_run_async ───────────────────────────────────────────
      // Wrapper exec returns the PID on stdout.
      session.responses.push({ stdout: '54321\n', exitCode: 0 });

      const startResp = await sshRunAsyncTool.handler(
        { environmentId: 'env_proc_int', command: 'sleep 30' },
        ctx,
      );
      expect(startResp.isError).toBeUndefined();
      const startBody = JSON.parse(startResp.content[0].text);
      expect(startBody.success).toBe(true);
      expect(startBody.jobId).toMatch(/^job_/);
      expect(startBody.pid).toBe(54321);
      const jobId = startBody.jobId;

      // Verify wrapper was nohup-backed and routed output to /tmp/<jobId>_*.
      const wrapperCmd = session.execCalls[0];
      expect(wrapperCmd).toContain('nohup');
      expect(wrapperCmd).toContain(`/tmp/${jobId}_out`);
      expect(wrapperCmd).toContain(`/tmp/${jobId}_err`);
      expect(wrapperCmd).toContain(`/tmp/${jobId}_exit`);
      // The wrapper actually backs it: `... & echo $!` is the trailing piece.
      expect(wrapperCmd).toMatch(/&\s+echo\s+\$!/);

      // Redis hash should hold the running job.
      const stored1 = await fake.hget(jobsHashKey('env_proc_int'), jobId);
      expect(stored1).not.toBeNull();
      expect((JSON.parse(stored1!) as AsyncJobMetadata).status).toBe('running');

      // ── Step 2: ssh_tail (job still running) ────────────────────────────
      session.responses.push({
        stdout: buildCompositeOutput({
          stdout: '', stderr: '', alive: '1', exit: 'NONE',
        }),
        exitCode: 0,
      });

      const tail1 = await sshTailTool.handler(
        { environmentId: 'env_proc_int', jobId, lines: 100 },
        ctx,
      );
      expect(tail1.isError).toBeUndefined();
      const tail1Body = JSON.parse(tail1.content[0].text);
      expect(tail1Body.isRunning).toBe(true);
      expect(tail1Body.status).toBe('running');
      expect(tail1Body.exitCode).toBeUndefined();

      // The composite read script should target the right files + PID.
      const tailCmd = session.execCalls[1];
      expect(tailCmd).toContain(`tail -n 100 /tmp/${jobId}_out`);
      expect(tailCmd).toContain(`tail -n 100 /tmp/${jobId}_err`);
      expect(tailCmd).toContain(`kill -0 54321`);
      expect(tailCmd).toContain(`cat /tmp/${jobId}_exit`);

      // ── Step 3: ssh_kill ────────────────────────────────────────────────
      // kill returned 0 → process was alive and got the signal.
      session.responses.push({ stdout: 'EXIT:0\n', exitCode: 0 });

      const killResp = await sshKillTool.handler(
        { environmentId: 'env_proc_int', jobId },
        ctx,
      );
      expect(killResp.isError).toBeUndefined();
      const killBody = JSON.parse(killResp.content[0].text);
      expect(killBody.success).toBe(true);
      expect(killBody.processWasRunning).toBe(true);
      expect(killBody.signal).toBe('TERM');
      expect(killBody.terminatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Kill script should target the right PID with the right signal.
      const killCmd = session.execCalls[2];
      expect(killCmd).toContain('kill -TERM 54321');

      // Redis hash should now show status='killed'.
      const stored2 = await fake.hget(jobsHashKey('env_proc_int'), jobId);
      expect((JSON.parse(stored2!) as AsyncJobMetadata).status).toBe('killed');

      // ── Step 4: ssh_jobs ────────────────────────────────────────────────
      // ssh_jobs is Redis-only — does NOT issue another exec call.
      const jobsResp = await sshJobsTool.handler(
        { environmentId: 'env_proc_int' },
        ctx,
      );
      expect(jobsResp.isError).toBeUndefined();
      const jobsBody = JSON.parse(jobsResp.content[0].text);
      expect(jobsBody.count).toBe(1);
      expect(jobsBody.jobs[0].jobId).toBe(jobId);
      expect(jobsBody.jobs[0].status).toBe('killed');
      expect(jobsBody.jobs[0].isRunning).toBe(false);
      expect(jobsBody.jobs[0].command).toBe('sleep 30');
      expect(jobsBody.jobs[0].pid).toBe(54321);

      // Critical: ssh_jobs did NOT issue a fourth exec call.
      expect(session.execCalls.length).toBe(3);

      // ── Step 5: ssh_tail again — wrapper has now written exit code ─────
      // Simulating: kill -TERM caused the inner subshell to terminate, and
      // the wrapper subshell wrote `143` (128 + SIGTERM=15) to _exit.
      session.responses.push({
        stdout: buildCompositeOutput({
          stdout: '', stderr: '', alive: '0', exit: '143',
        }),
        exitCode: 0,
      });

      const tail2 = await sshTailTool.handler(
        { environmentId: 'env_proc_int', jobId },
        ctx,
      );
      expect(tail2.isError).toBeUndefined();
      const tail2Body = JSON.parse(tail2.content[0].text);
      expect(tail2Body.isRunning).toBe(false);
      expect(tail2Body.exitCode).toBe(143);
      // Status preserves 'killed' (was already killed; tail doesn't downgrade).
      expect(tail2Body.status).toBe('killed');

      expect(session.execCalls.length).toBe(4);
    });

    test('multiple concurrent jobs share the same env hash; ssh_jobs returns all', async () => {
      const ctx = makeMockContext();

      session.responses.push({ stdout: '111\n', exitCode: 0 });
      session.responses.push({ stdout: '222\n', exitCode: 0 });
      session.responses.push({ stdout: '333\n', exitCode: 0 });

      const jobIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await sshRunAsyncTool.handler(
          { environmentId: 'env_proc_int', command: `sleep ${i + 1}` },
          ctx,
        );
        jobIds.push(JSON.parse(r.content[0].text).jobId);
      }

      const jobsResp = await sshJobsTool.handler(
        { environmentId: 'env_proc_int' },
        ctx,
      );
      const jobsBody = JSON.parse(jobsResp.content[0].text);
      expect(jobsBody.count).toBe(3);
      // All three job IDs should be in the listing (any order).
      const returnedIds = jobsBody.jobs.map((j: { jobId: string }) => j.jobId).sort();
      expect(returnedIds).toEqual(jobIds.sort());
    });

    test('ssh_kill is idempotent: killing an already-exited job still succeeds', async () => {
      const ctx = makeMockContext();

      // Pre-seed an exited job (no run_async needed).
      const meta: AsyncJobMetadata = {
        jobId: 'job_zombie',
        command: 'echo hi',
        startedAt: new Date().toISOString(),
        status: 'exited',
        pid: 99999,
        exitCode: 0,
        exitedAt: new Date().toISOString(),
      };
      await fake.hset(jobsHashKey('env_proc_int'), 'job_zombie', JSON.stringify(meta));

      // kill returns exit 1 (process already gone).
      session.responses.push({ stdout: 'kill: (99999) - No such process\nEXIT:1\n', exitCode: 0 });

      const killResp = await sshKillTool.handler(
        { environmentId: 'env_proc_int', jobId: 'job_zombie' },
        ctx,
      );
      expect(killResp.isError).toBeUndefined();
      const killBody = JSON.parse(killResp.content[0].text);
      expect(killBody.success).toBe(true);
      expect(killBody.processWasRunning).toBe(false);

      // Status flips to 'killed' regardless.
      const stored = await fake.hget(jobsHashKey('env_proc_int'), 'job_zombie');
      expect((JSON.parse(stored!) as AsyncJobMetadata).status).toBe('killed');
    });
  });
});
