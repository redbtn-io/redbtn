/**
 * Vitest for native tool: ssh_tail (Env Phase D — process pack)
 *
 * Coverage:
 *   1. Schema (description / required / props / server label)
 *   2. Validation (missing/wrong-type inputs, missing userId)
 *   3. JOB_NOT_FOUND when the Redis hash has no entry for the jobId
 *   4. Happy path (running): isRunning=true, no exitCode, no Redis update
 *   5. Happy path (just exited): isRunning=false, exitCode parsed, Redis
 *      reconciled to status='exited'
 *   6. Composite read parses NUL-flanked TAGs correctly
 *   7. Resolution failure passes through with original code
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

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

import sshTailTool from '../../src/lib/tools/native/ssh-tail';
import {
  jobsHashKey,
  __setRedisClientForTests,
  type AsyncJobMetadata,
} from '../../src/lib/tools/native/ssh-run-async';
import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';

// ---------------------------------------------------------------------------
// Tiny in-memory Redis stub (hash-only)
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
    async hget(key: string, field: string) {
      return data.get(key)?.get(field) ?? null;
    },
    async hgetall(key: string) {
      const h = data.get(key);
      return h ? Object.fromEntries(h.entries()) : {};
    },
    async expire(_key: string, _ttl: number) { return 1; },
    pipeline() {
      const ops: Array<() => Promise<void>> = [];
      const p = {
        hset(key: string, field: string, value: string) {
          ops.push(async () => { await fake.hset(key, field, value); });
          return p;
        },
        expire(key: string, ttl: number) {
          ops.push(async () => { await fake.expire(key, ttl); });
          return p;
        },
        async exec() { for (const op of ops) await op(); },
      };
      return p;
    },
    on() { /* noop */ },
  };
  return fake;
}

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1' },
    runId: 'test-run',
    nodeId: 'test-node',
    toolId: 'test-tool',
    abortSignal: null,
    ...overrides,
  };
}

const FAKE_ENV = {
  environmentId: 'env_proc',
  userId: 'user-1',
  name: 'proc env',
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
 * The tags are NUL-flanked, exactly mirroring the script in ssh-tail.ts.
 */
function buildCompositeOutput(opts: {
  stdout: string;
  stderr: string;
  alive: '0' | '1';
  exit: string; // 'NONE' | numeric
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

describe('ssh_tail — schema', () => {
  test('description references the polling pattern', () => {
    expect(sshTailTool.description.toLowerCase()).toMatch(/stdout|stderr|exit/);
  });
  test('environmentId + jobId required; lines + follow optional', () => {
    expect(sshTailTool.inputSchema.required).toEqual(['environmentId', 'jobId']);
    expect(sshTailTool.inputSchema.properties.lines).toBeDefined();
    expect(sshTailTool.inputSchema.properties.follow).toBeDefined();
  });
  test('server label is system', () => {
    expect(sshTailTool.server).toBe('system');
  });
});

describe('ssh_tail — validation', () => {
  beforeEach(() => __setRedisClientForTests(makeFakeRedis()));
  afterEach(() => __setRedisClientForTests(null));

  test('missing environmentId → VALIDATION', async () => {
    const r = await sshTailTool.handler({ jobId: 'job_xxx' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
  test('missing jobId → VALIDATION', async () => {
    const r = await sshTailTool.handler({ environmentId: 'env_proc' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
  test('non-integer lines → VALIDATION', async () => {
    const r = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId: 'job_x', lines: 1.5 },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
  test('lines out of range → VALIDATION', async () => {
    const r = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId: 'job_x', lines: 0 },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const r2 = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId: 'job_x', lines: 99999 },
      makeMockContext(),
    );
    expect(r2.isError).toBe(true);
  });
  test('non-boolean follow → VALIDATION', async () => {
    const r = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId: 'job_x', follow: 'yes' as unknown as boolean },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
  });
  test('missing userId → MISSING_USER', async () => {
    const r = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId: 'job_x' },
      makeMockContext({ state: {} }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('MISSING_USER');
  });
});

describe('ssh_tail — execution', () => {
  let fake: ReturnType<typeof makeFakeRedis>;

  beforeEach(() => {
    fake = makeFakeRedis();
    __setRedisClientForTests(fake);
  });
  afterEach(() => {
    vi.clearAllMocks();
    __setRedisClientForTests(null);
  });

  async function seedRunningJob(): Promise<string> {
    const meta: AsyncJobMetadata = {
      jobId: 'job_aaa',
      command: 'sleep 30',
      cwd: '/tmp',
      env: undefined,
      startedAt: new Date().toISOString(),
      status: 'running',
      pid: 12345,
    };
    await fake.hset(jobsHashKey('env_proc'), 'job_aaa', JSON.stringify(meta));
    return 'job_aaa';
  }

  test('JOB_NOT_FOUND when no entry in Redis', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const r = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId: 'job_does_not_exist' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('JOB_NOT_FOUND');
  });

  test('happy path running: isRunning=true, no exitCode, status=running, no Redis update', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const jobId = await seedRunningJob();

    const fakeSession = {
      exec: vi.fn(async () => ({
        stdout: buildCompositeOutput({
          stdout: 'line 1\nline 2\n',
          stderr: '',
          alive: '1',
          exit: 'NONE',
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 5,
        truncated: false,
      })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(environmentManager.acquire).mockResolvedValue(fakeSession as any);

    const r = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId },
      makeMockContext(),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.success).toBe(true);
    expect(body.isRunning).toBe(true);
    expect(body.status).toBe('running');
    expect(body.stdout).toBe('line 1\nline 2\n');
    expect(body.stderr).toBe('');
    expect(body.exitCode).toBeUndefined();
    expect(body.pid).toBe(12345);

    // Hash entry should still say running.
    const stored = await fake.hget(jobsHashKey('env_proc'), jobId);
    expect(JSON.parse(stored!).status).toBe('running');
  });

  test('happy path just-exited: isRunning=false, exitCode parsed, Redis flips to exited', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const jobId = await seedRunningJob();

    const fakeSession = {
      exec: vi.fn(async () => ({
        stdout: buildCompositeOutput({
          stdout: 'final output\n',
          stderr: 'a warning\n',
          alive: '0',
          exit: '0',
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 5,
        truncated: false,
      })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(environmentManager.acquire).mockResolvedValue(fakeSession as any);

    const r = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId },
      makeMockContext(),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.isRunning).toBe(false);
    expect(body.exitCode).toBe(0);
    expect(body.status).toBe('exited');
    expect(body.stdout).toBe('final output\n');
    expect(body.stderr).toBe('a warning\n');

    // Hash entry should be reconciled.
    const stored = await fake.hget(jobsHashKey('env_proc'), jobId);
    const parsed = JSON.parse(stored!);
    expect(parsed.status).toBe('exited');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.exitedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('exited but exit file says NONE → exitCode is undefined (not yet readable)', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const jobId = await seedRunningJob();

    const fakeSession = {
      exec: vi.fn(async () => ({
        stdout: buildCompositeOutput({
          stdout: 'partial\n',
          stderr: '',
          alive: '0',
          exit: 'NONE',
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 5,
        truncated: false,
      })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(environmentManager.acquire).mockResolvedValue(fakeSession as any);

    const r = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.isRunning).toBe(false);
    expect(body.exitCode).toBeUndefined();
    // Status still reconciled to 'exited'.
    expect(body.status).toBe('exited');

    // The Redis entry's exitCode should be null (we observed exit but couldn't read code).
    const stored = await fake.hget(jobsHashKey('env_proc'), jobId);
    const parsed = JSON.parse(stored!);
    expect(parsed.exitCode).toBe(null);
  });

  test('previously-killed job: status preserved, exitCode preserved if missing from disk', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const meta: AsyncJobMetadata = {
      jobId: 'job_killed',
      command: 'sleep',
      startedAt: new Date().toISOString(),
      status: 'killed',
      pid: 999,
      exitCode: 137,
      exitedAt: new Date().toISOString(),
    };
    await fake.hset(jobsHashKey('env_proc'), 'job_killed', JSON.stringify(meta));

    const fakeSession = {
      exec: vi.fn(async () => ({
        stdout: buildCompositeOutput({
          stdout: '',
          stderr: '',
          alive: '0',
          exit: 'NONE',
        }),
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        truncated: false,
      })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(environmentManager.acquire).mockResolvedValue(fakeSession as any);

    const r = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId: 'job_killed' },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.isRunning).toBe(false);
    expect(body.status).toBe('killed');
    // Falls back to the recorded exitCode since /tmp/exit was missing.
    expect(body.exitCode).toBe(137);
  });

  test('resolution failure → original code passes through', async () => {
    await seedRunningJob();
    vi.mocked(loadAndResolveEnvironment).mockRejectedValue(
      Object.assign(new Error('access denied'), { code: 'ENV_ACCESS_DENIED' }),
    );
    const r = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId: 'job_aaa' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('ENV_ACCESS_DENIED');
  });

  test('exec failure → READ_FAILED', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    await seedRunningJob();
    vi.mocked(environmentManager.acquire).mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: vi.fn(async () => { throw new Error('connection lost'); }),
    } as any);
    const r = await sshTailTool.handler(
      { environmentId: 'env_proc', jobId: 'job_aaa' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('READ_FAILED');
  });

  test('lines argument is forwarded into the read script', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const jobId = await seedRunningJob();
    let captured = '';
    const fakeSession = {
      exec: vi.fn(async (cmd: string) => {
        captured = cmd;
        return {
          stdout: buildCompositeOutput({ stdout: '', stderr: '', alive: '1', exit: 'NONE' }),
          stderr: '', exitCode: 0, durationMs: 1, truncated: false,
        };
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(environmentManager.acquire).mockResolvedValue(fakeSession as any);
    await sshTailTool.handler(
      { environmentId: 'env_proc', jobId, lines: 200 },
      makeMockContext(),
    );
    // The script invokes `tail -n 200 ...` for both stdout and stderr.
    expect(captured).toContain('tail -n 200');
  });
});
