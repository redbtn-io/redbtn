/**
 * Vitest for native tool: ssh_run_async (Env Phase D — process pack)
 *
 * Tests the four major paths:
 *   1. Schema shape (description / required / props / server label)
 *   2. Validation errors (missing/wrong-type inputs, missing userId)
 *   3. Resolution failures pass through with original error code
 *   4. Happy path: wrapper command is built, PID parsed, Redis updated
 *
 * # Mocking strategy
 *
 * - `loadAndResolveEnvironment` is mocked so we don't touch Mongo / redsecrets.
 * - `environmentManager.acquire` is replaced with a stub that returns a
 *   fake session whose `exec` returns whatever the test configured.
 * - `getRedisClient` (exported helper from ssh-run-async itself) is replaced
 *   with an in-memory hash-only mock — enough surface for the pack.
 *
 * The mocks intentionally don't try to simulate a full ssh2 stack because the
 * EnvironmentSession-side machinery is already exhaustively tested in
 * `tests/environments/`. Here we're verifying the tool's own logic on top.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

// Stub the resolution helper so we don't hit Mongo.
vi.mock('../../src/lib/environments/loadAndResolveEnvironment', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/loadAndResolveEnvironment')>(
    '../../src/lib/environments/loadAndResolveEnvironment',
  );
  return {
    ...actual,
    loadAndResolveEnvironment: vi.fn(),
  };
});

// Stub the manager so we control the session behaviour.
vi.mock('../../src/lib/environments/EnvironmentManager', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/EnvironmentManager')>(
    '../../src/lib/environments/EnvironmentManager',
  );
  return {
    ...actual,
    environmentManager: {
      acquire: vi.fn(),
    },
  };
});

import sshRunAsyncTool, {
  jobsHashKey,
  __setRedisClientForTests,
} from '../../src/lib/tools/native/ssh-run-async';
import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';

// ---------------------------------------------------------------------------
// In-memory Redis stub
// ---------------------------------------------------------------------------

interface FakeRedis {
  data: Map<string, Map<string, string>>;
  expirations: Map<string, number>;
  hset: (key: string, field: string, value: string) => Promise<number>;
  hget: (key: string, field: string) => Promise<string | null>;
  hgetall: (key: string) => Promise<Record<string, string>>;
  expire: (key: string, ttl: number) => Promise<number>;
  pipeline: () => FakePipeline;
  on: (_event: string, _cb: (err: Error) => void) => void;
}

interface FakePipeline {
  hset: (key: string, field: string, value: string) => FakePipeline;
  expire: (key: string, ttl: number) => FakePipeline;
  exec: () => Promise<void>;
}

function makeFakeRedis(): FakeRedis {
  const data = new Map<string, Map<string, string>>();
  const expirations = new Map<string, number>();
  return {
    data,
    expirations,
    async hset(key, field, value) {
      let h = data.get(key);
      if (!h) {
        h = new Map();
        data.set(key, h);
      }
      const isNew = !h.has(field);
      h.set(field, value);
      return isNew ? 1 : 0;
    },
    async hget(key, field) {
      return data.get(key)?.get(field) ?? null;
    },
    async hgetall(key) {
      const h = data.get(key);
      if (!h) return {};
      return Object.fromEntries(h.entries());
    },
    async expire(key, ttl) {
      expirations.set(key, ttl);
      return data.has(key) ? 1 : 0;
    },
    pipeline() {
      const ops: Array<() => Promise<void>> = [];
      const p: FakePipeline = {
        hset(key, field, value) {
          ops.push(async () => { void (await this.hset(key, field, value)); });
          return p;
        },
        expire(key, ttl) {
          ops.push(async () => { void (await this.expire(key, ttl)); });
          return p;
        },
        async exec() {
          // Run the captured operations against the parent fake.
          // We re-bind so each op invokes the outer fake's methods.
        },
      };
      // Re-bind hset/expire on the pipeline so they use the outer fake.
      p.hset = (key, field, value) => {
        ops.push(async () => { await fake.hset(key, field, value); });
        return p;
      };
      p.expire = (key, ttl) => {
        ops.push(async () => { await fake.expire(key, ttl); });
        return p;
      };
      p.exec = async () => {
        for (const op of ops) await op();
      };
      return p;
    },
    on(_event, _cb) { /* noop */ },
  };
  // The above pipeline rebind references `fake`; declare it after construction.
}

// Fixed declaration so the `pipeline` rebind reference resolves cleanly.
let fake: FakeRedis;

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1' },
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
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

describe('ssh_run_async — schema', () => {
  test('description references the long-running pattern', () => {
    expect(sshRunAsyncTool.description.toLowerCase()).toContain('long-running');
    expect(sshRunAsyncTool.description.toLowerCase()).toContain('jobid');
  });
  test('environmentId + command required; cwd + env optional', () => {
    expect(sshRunAsyncTool.inputSchema.required).toEqual(['environmentId', 'command']);
    expect(sshRunAsyncTool.inputSchema.properties.environmentId).toBeDefined();
    expect(sshRunAsyncTool.inputSchema.properties.command).toBeDefined();
    expect(sshRunAsyncTool.inputSchema.properties.cwd).toBeDefined();
    expect(sshRunAsyncTool.inputSchema.properties.env).toBeDefined();
  });
  test('server label is system', () => {
    expect(sshRunAsyncTool.server).toBe('system');
  });
});

describe('ssh_run_async — validation', () => {
  test('missing environmentId → VALIDATION', async () => {
    const r = await sshRunAsyncTool.handler({ command: 'echo' }, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/environmentId/);
  });
  test('missing command → VALIDATION', async () => {
    const r = await sshRunAsyncTool.handler({ environmentId: 'env_proc' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
  test('non-string cwd → VALIDATION', async () => {
    const r = await sshRunAsyncTool.handler(
      { environmentId: 'env_proc', command: 'ls', cwd: 123 as unknown as string },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
  test('array env → VALIDATION', async () => {
    const r = await sshRunAsyncTool.handler(
      // @ts-expect-error -- testing wrong shape
      { environmentId: 'env_proc', command: 'ls', env: ['NOT', 'AN', 'OBJECT'] },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
  test('missing userId → MISSING_USER', async () => {
    const r = await sshRunAsyncTool.handler(
      { environmentId: 'env_proc', command: 'ls' },
      makeMockContext({ state: {} }),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('MISSING_USER');
  });
});

describe('ssh_run_async — execution', () => {
  beforeEach(() => {
    fake = makeFakeRedis();
    __setRedisClientForTests(fake);
  });

  afterEach(() => {
    vi.clearAllMocks();
    __setRedisClientForTests(null);
  });

  test('resolution failure → tool error with original code', async () => {
    vi.mocked(loadAndResolveEnvironment).mockRejectedValue(
      Object.assign(new Error('Environment not found: env_x'), { code: 'ENV_NOT_FOUND' }),
    );
    const r = await sshRunAsyncTool.handler(
      { environmentId: 'env_x', command: 'ls' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('ENV_NOT_FOUND');
    expect(body.error).toMatch(/Environment not found/);
  });

  test('manager.acquire failure → ACQUIRE_FAILED', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    vi.mocked(environmentManager.acquire).mockRejectedValue(new Error('SSH auth failed'));
    const r = await sshRunAsyncTool.handler(
      { environmentId: 'env_proc', command: 'ls' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('ACQUIRE_FAILED');
    expect(body.error).toMatch(/SSH auth failed/);
  });

  test('happy path: returns jobId + pid + ISO startedAt; stashes hash entry', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    let captured = '';
    const fakeSession = {
      exec: vi.fn(async (cmd: string) => {
        captured = cmd;
        // Wrapper echoes a PID. Mock returns "12345\n".
        return { stdout: '12345\n', stderr: '', exitCode: 0, durationMs: 4, truncated: false };
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(environmentManager.acquire).mockResolvedValue(fakeSession as any);

    const r = await sshRunAsyncTool.handler(
      { environmentId: 'env_proc', command: 'sleep 30', cwd: '/var/tmp', env: { FOO: 'bar' } },
      makeMockContext(),
    );

    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.success).toBe(true);
    expect(body.jobId).toMatch(/^job_[A-Za-z0-9_-]{8}$/);
    expect(body.pid).toBe(12345);
    expect(body.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.environmentId).toBe('env_proc');

    // Wrapper command should include nohup, /tmp/<jobId>_out, _err, _exit.
    expect(captured).toContain('nohup');
    expect(captured).toContain(`/tmp/${body.jobId}_out`);
    expect(captured).toContain(`/tmp/${body.jobId}_err`);
    expect(captured).toContain(`/tmp/${body.jobId}_exit`);
    // Wrapper should bake in cwd and env vars.
    expect(captured).toContain('cd');
    expect(captured).toContain('/var/tmp');
    expect(captured).toContain('FOO=');

    // Hash entry should be present with status='running'.
    const stored = await fake.hget(jobsHashKey('env_proc'), body.jobId);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.jobId).toBe(body.jobId);
    expect(parsed.command).toBe('sleep 30');
    expect(parsed.status).toBe('running');
    expect(parsed.pid).toBe(12345);
    expect(parsed.cwd).toBe('/var/tmp');
    expect(parsed.env).toEqual({ FOO: 'bar' });
    // TTL should be set.
    expect(fake.expirations.get(jobsHashKey('env_proc'))).toBe(24 * 60 * 60);
  });

  test('wrapper non-zero exit → EXEC_FAILED', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    vi.mocked(environmentManager.acquire).mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: vi.fn(async () => ({ stdout: '', stderr: 'oops', exitCode: 127, durationMs: 1, truncated: false })),
    } as any);

    const r = await sshRunAsyncTool.handler(
      { environmentId: 'env_proc', command: 'noexist' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('EXEC_FAILED');
  });

  test('non-numeric PID → BAD_PID', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    vi.mocked(environmentManager.acquire).mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: vi.fn(async () => ({ stdout: 'not-a-number\n', stderr: '', exitCode: 0, durationMs: 1, truncated: false })),
    } as any);

    const r = await sshRunAsyncTool.handler(
      { environmentId: 'env_proc', command: 'ls' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('BAD_PID');
  });

  test('exec throw → EXEC_FAILED', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    vi.mocked(environmentManager.acquire).mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: vi.fn(async () => { throw new Error('connection lost'); }),
    } as any);

    const r = await sshRunAsyncTool.handler(
      { environmentId: 'env_proc', command: 'ls' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('EXEC_FAILED');
    expect(body.error).toMatch(/connection lost/);
  });

  test('jobIds are unique across calls', async () => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    vi.mocked(environmentManager.acquire).mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: vi.fn(async () => ({ stdout: '999\n', stderr: '', exitCode: 0, durationMs: 1, truncated: false })),
    } as any);

    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = await sshRunAsyncTool.handler(
        { environmentId: 'env_proc', command: `echo ${i}` },
        makeMockContext(),
      );
      ids.add(JSON.parse(r.content[0].text).jobId);
    }
    expect(ids.size).toBe(5);
  });
});
