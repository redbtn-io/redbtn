/**
 * Vitest for native tool: ssh_jobs (Env Phase D — process pack)
 *
 * Coverage:
 *   1. Schema (description / required / props / server label)
 *   2. Validation (missing input, missing userId)
 *   3. Empty hash returns empty list
 *   4. Multiple jobs returned + sorted newest-first
 *   5. Per-job fields are surfaced (status, isRunning, exitCode when present)
 *   6. Malformed entries are skipped, not crashing the listing
 *   7. Resolution failure (access check via loadAndResolveEnvironment)
 *   8. Redis HGETALL failure → REDIS_FAILED
 *   9. ssh_jobs does NOT call environmentManager.acquire (no SSH)
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

import sshJobsTool from '../../src/lib/tools/native/ssh-jobs';
import {
  jobsHashKey,
  __setRedisClientForTests,
  type AsyncJobMetadata,
} from '../../src/lib/tools/native/ssh-run-async';
import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';

function makeFakeRedis(opts: { failHgetall?: boolean } = {}) {
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
      if (opts.failHgetall) throw new Error('Redis offline');
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

describe('ssh_jobs — schema', () => {
  test('description references job enumeration', () => {
    expect(sshJobsTool.description.toLowerCase()).toMatch(/list|jobs/);
  });
  test('environmentId required; no other inputs', () => {
    expect(sshJobsTool.inputSchema.required).toEqual(['environmentId']);
  });
  test('server label is system', () => {
    expect(sshJobsTool.server).toBe('system');
  });
});

describe('ssh_jobs — validation', () => {
  beforeEach(() => __setRedisClientForTests(makeFakeRedis()));
  afterEach(() => __setRedisClientForTests(null));

  test('missing environmentId → VALIDATION', async () => {
    const r = await sshJobsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
  test('non-string environmentId → VALIDATION', async () => {
    const r = await sshJobsTool.handler({ environmentId: 123 }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
  test('missing userId → MISSING_USER', async () => {
    const r = await sshJobsTool.handler(
      { environmentId: 'env_proc' },
      makeMockContext({ state: {} }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('MISSING_USER');
  });
});

describe('ssh_jobs — execution', () => {
  let fake: ReturnType<typeof makeFakeRedis>;

  beforeEach(() => {
    fake = makeFakeRedis();
    __setRedisClientForTests(fake);
  });
  afterEach(() => {
    vi.clearAllMocks();
    __setRedisClientForTests(null);
  });

  test('empty hash → empty list', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const r = await sshJobsTool.handler(
      { environmentId: 'env_proc' },
      makeMockContext(),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.success).toBe(true);
    expect(body.count).toBe(0);
    expect(body.jobs).toEqual([]);
  });

  test('multiple jobs returned, sorted newest-first by startedAt', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });

    const old: AsyncJobMetadata = {
      jobId: 'job_old',
      command: 'old',
      startedAt: new Date('2026-04-25T00:00:00Z').toISOString(),
      status: 'exited',
      pid: 100,
      exitCode: 0,
      exitedAt: new Date('2026-04-25T00:01:00Z').toISOString(),
    };
    const middle: AsyncJobMetadata = {
      jobId: 'job_mid',
      command: 'mid',
      startedAt: new Date('2026-04-26T00:00:00Z').toISOString(),
      status: 'killed',
      pid: 200,
      exitedAt: new Date('2026-04-26T00:00:30Z').toISOString(),
    };
    const recent: AsyncJobMetadata = {
      jobId: 'job_new',
      command: 'new',
      startedAt: new Date('2026-04-27T00:00:00Z').toISOString(),
      status: 'running',
      pid: 300,
    };
    await fake.hset(jobsHashKey('env_proc'), 'job_old', JSON.stringify(old));
    await fake.hset(jobsHashKey('env_proc'), 'job_mid', JSON.stringify(middle));
    await fake.hset(jobsHashKey('env_proc'), 'job_new', JSON.stringify(recent));

    const r = await sshJobsTool.handler(
      { environmentId: 'env_proc' },
      makeMockContext(),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.count).toBe(3);
    // Newest first.
    expect(body.jobs[0].jobId).toBe('job_new');
    expect(body.jobs[1].jobId).toBe('job_mid');
    expect(body.jobs[2].jobId).toBe('job_old');
    // Per-job structure.
    expect(body.jobs[0].isRunning).toBe(true);
    expect(body.jobs[1].isRunning).toBe(false);
    expect(body.jobs[1].status).toBe('killed');
    expect(body.jobs[2].exitCode).toBe(0);
  });

  test('malformed JSON entries are skipped, not crashing', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });

    const ok: AsyncJobMetadata = {
      jobId: 'job_ok',
      command: 'good',
      startedAt: new Date().toISOString(),
      status: 'running',
      pid: 1,
    };
    await fake.hset(jobsHashKey('env_proc'), 'job_ok', JSON.stringify(ok));
    await fake.hset(jobsHashKey('env_proc'), 'job_bad', '{not valid json');

    const r = await sshJobsTool.handler(
      { environmentId: 'env_proc' },
      makeMockContext(),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    // Only the good one survives.
    expect(body.count).toBe(1);
    expect(body.jobs[0].jobId).toBe('job_ok');
  });

  test('resolution failure → original code passes through', async () => {
    vi.mocked(loadAndResolveEnvironment).mockRejectedValue(
      Object.assign(new Error('access denied'), { code: 'ENV_ACCESS_DENIED' }),
    );
    const r = await sshJobsTool.handler(
      { environmentId: 'env_proc' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('ENV_ACCESS_DENIED');
  });

  test('Redis HGETALL failure → REDIS_FAILED', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    __setRedisClientForTests(makeFakeRedis({ failHgetall: true }));
    const r = await sshJobsTool.handler(
      { environmentId: 'env_proc' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('REDIS_FAILED');
  });

  test('does NOT call environmentManager.acquire (Redis-only)', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    await sshJobsTool.handler({ environmentId: 'env_proc' }, makeMockContext());
    expect(environmentManager.acquire).not.toHaveBeenCalled();
  });
});
