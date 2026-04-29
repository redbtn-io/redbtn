/**
 * Vitest for native tool: ssh_kill (Env Phase D — process pack)
 *
 * Coverage:
 *   1. Schema (description / required / props / server label / signal enum)
 *   2. Validation (missing inputs, missing userId, bad signal)
 *   3. JOB_NOT_FOUND when no Redis entry
 *   4. Happy path: kill issued, Redis status='killed', terminatedAt returned
 *   5. Idempotent: process already exited still succeeds, processWasRunning=false
 *   6. Custom signals (KILL, INT) accepted; SIG-prefix stripped
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

import sshKillTool from '../../src/lib/tools/native/ssh-kill';
import {
  jobsHashKey,
  __setRedisClientForTests,
  type AsyncJobMetadata,
} from '../../src/lib/tools/native/ssh-run-async';
import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';

function makeFakeRedis() {
  const data = new Map<string, Map<string, string>>();
  return {
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
    async expire() { return 1; },
    pipeline() { return { hset: () => this, expire: () => this, exec: async () => {} }; },
    on() { /* noop */ },
  };
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

describe('ssh_kill — schema', () => {
  test('description references signal handling', () => {
    expect(sshKillTool.description.toLowerCase()).toMatch(/signal/);
  });
  test('environmentId + jobId required; signal optional with enum', () => {
    expect(sshKillTool.inputSchema.required).toEqual(['environmentId', 'jobId']);
    expect(sshKillTool.inputSchema.properties.signal.enum).toContain('TERM');
    expect(sshKillTool.inputSchema.properties.signal.enum).toContain('KILL');
  });
  test('server label is system', () => {
    expect(sshKillTool.server).toBe('system');
  });
});

describe('ssh_kill — validation', () => {
  beforeEach(() => __setRedisClientForTests(makeFakeRedis()));
  afterEach(() => __setRedisClientForTests(null));

  test('missing environmentId → VALIDATION', async () => {
    const r = await sshKillTool.handler({ jobId: 'job_x' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
  test('missing jobId → VALIDATION', async () => {
    const r = await sshKillTool.handler({ environmentId: 'env_proc' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
  test('non-string signal → VALIDATION', async () => {
    const r = await sshKillTool.handler(
      { environmentId: 'env_proc', jobId: 'job_x', signal: 9 as unknown as string },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
  test('disallowed signal → VALIDATION (lists allowed)', async () => {
    const r = await sshKillTool.handler(
      { environmentId: 'env_proc', jobId: 'job_x', signal: 'WINCH' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toMatch(/TERM|KILL/);
  });
  test('missing userId → MISSING_USER', async () => {
    const r = await sshKillTool.handler(
      { environmentId: 'env_proc', jobId: 'job_x' },
      makeMockContext({ state: {} }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('MISSING_USER');
  });
});

describe('ssh_kill — execution', () => {
  let fake: ReturnType<typeof makeFakeRedis>;

  beforeEach(() => {
    fake = makeFakeRedis();
    __setRedisClientForTests(fake);
  });
  afterEach(() => {
    vi.clearAllMocks();
    __setRedisClientForTests(null);
  });

  async function seedJob(overrides: Partial<AsyncJobMetadata> = {}): Promise<string> {
    const meta: AsyncJobMetadata = {
      jobId: 'job_kk',
      command: 'sleep 30',
      cwd: '/tmp',
      env: undefined,
      startedAt: new Date().toISOString(),
      status: 'running',
      pid: 12345,
      ...overrides,
    };
    await fake.hset(jobsHashKey('env_proc'), 'job_kk', JSON.stringify(meta));
    return 'job_kk';
  }

  test('JOB_NOT_FOUND when not in Redis', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const r = await sshKillTool.handler(
      { environmentId: 'env_proc', jobId: 'job_missing' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('JOB_NOT_FOUND');
  });

  test('happy path TERM: kill returns 0 → processWasRunning=true; Redis status=killed', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const jobId = await seedJob();
    let captured = '';
    const fakeSession = {
      exec: vi.fn(async (cmd: string) => {
        captured = cmd;
        return { stdout: 'EXIT:0\n', stderr: '', exitCode: 0, durationMs: 1, truncated: false };
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(environmentManager.acquire).mockResolvedValue(fakeSession as any);

    const r = await sshKillTool.handler(
      { environmentId: 'env_proc', jobId },
      makeMockContext(),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.success).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.signal).toBe('TERM');
    expect(body.processWasRunning).toBe(true);
    expect(body.terminatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.pid).toBe(12345);

    // Kill script should target PID 12345 with TERM.
    expect(captured).toContain('kill -TERM 12345');

    // Redis status flipped.
    const stored = await fake.hget(jobsHashKey('env_proc'), jobId);
    const parsed = JSON.parse(stored!);
    expect(parsed.status).toBe('killed');
    expect(parsed.exitedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('idempotent: process already gone → kill exit 1 → processWasRunning=false but success', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const jobId = await seedJob();
    const fakeSession = {
      exec: vi.fn(async () => ({
        stdout: 'kill: (12345) - No such process\nEXIT:1\n',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        truncated: false,
      })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(environmentManager.acquire).mockResolvedValue(fakeSession as any);

    const r = await sshKillTool.handler(
      { environmentId: 'env_proc', jobId },
      makeMockContext(),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.success).toBe(true);
    expect(body.processWasRunning).toBe(false);

    // Status still flipped.
    const stored = await fake.hget(jobsHashKey('env_proc'), jobId);
    expect(JSON.parse(stored!).status).toBe('killed');
  });

  test('KILL signal accepted; appears in script', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const jobId = await seedJob();
    let captured = '';
    const fakeSession = {
      exec: vi.fn(async (cmd: string) => {
        captured = cmd;
        return { stdout: 'EXIT:0\n', stderr: '', exitCode: 0, durationMs: 1, truncated: false };
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(environmentManager.acquire).mockResolvedValue(fakeSession as any);

    const r = await sshKillTool.handler(
      { environmentId: 'env_proc', jobId, signal: 'KILL' },
      makeMockContext(),
    );
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text).signal).toBe('KILL');
    expect(captured).toContain('kill -KILL');
  });

  test('SIG prefix stripped; SIGTERM accepted as TERM', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const jobId = await seedJob();
    const fakeSession = {
      exec: vi.fn(async () => ({ stdout: 'EXIT:0\n', stderr: '', exitCode: 0, durationMs: 1, truncated: false })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(environmentManager.acquire).mockResolvedValue(fakeSession as any);

    const r = await sshKillTool.handler(
      { environmentId: 'env_proc', jobId, signal: 'SIGTERM' },
      makeMockContext(),
    );
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text).signal).toBe('TERM');
  });

  test('lowercase signal accepted (normalized to uppercase)', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const jobId = await seedJob();
    const fakeSession = {
      exec: vi.fn(async () => ({ stdout: 'EXIT:0\n', stderr: '', exitCode: 0, durationMs: 1, truncated: false })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(environmentManager.acquire).mockResolvedValue(fakeSession as any);
    const r = await sshKillTool.handler(
      { environmentId: 'env_proc', jobId, signal: 'kill' },
      makeMockContext(),
    );
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text).signal).toBe('KILL');
  });

  test('exec throw → KILL_FAILED', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    await seedJob();
    vi.mocked(environmentManager.acquire).mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: vi.fn(async () => { throw new Error('connection lost'); }),
    } as any);

    const r = await sshKillTool.handler(
      { environmentId: 'env_proc', jobId: 'job_kk' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('KILL_FAILED');
  });

  test('resolution failure → original code passes through', async () => {
    await seedJob();
    vi.mocked(loadAndResolveEnvironment).mockRejectedValue(
      Object.assign(new Error('access denied'), { code: 'ENV_ACCESS_DENIED' }),
    );
    const r = await sshKillTool.handler(
      { environmentId: 'env_proc', jobId: 'job_kk' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('ENV_ACCESS_DENIED');
  });
});
