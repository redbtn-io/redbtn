import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireCopilotLease,
  COPILOT_MAX_CONCURRENT,
  COPILOT_LEASE_TTL_MS,
  COPILOT_LEASE_ACQUIRE_SCRIPT,
  COPILOT_LEASE_RELEASE_SCRIPT,
  COPILOT_LEASE_RENEW_SCRIPT,
  type CopilotRedisLeaseClient,
} from '../../src/lib/nodes/universal/executors/copilotSdkLease';
import { runCopilotSdkStep, type CopilotSdkDependencies } from '../../src/lib/nodes/universal/executors/copilotSdkExecutor';

class SharedRedis implements CopilotRedisLeaseClient {
  readonly entries = new Map<string, Map<string, number>>();
  readonly calls: Array<{ script: string; args: Array<string | number> }> = [];
  serverTimeMs = 1_700_000_000_000;
  async eval(script: string, _keys: number, key: string, ...args: (string | number)[]): Promise<number> {
    this.calls.push({ script, args: [key, ...args] });
    const set = this.entries.get(key) ?? new Map<string, number>();
    this.entries.set(key, set);
    if (script === COPILOT_LEASE_ACQUIRE_SCRIPT) {
      const now = this.serverTimeMs;
      for (const [token, expires] of set) if (expires <= now) set.delete(token);
      if (set.size >= Number(args[1])) return 0;
      set.set(String(args[2]), now + Number(args[0]));
      return 1;
    }
    if (script === COPILOT_LEASE_RENEW_SCRIPT) {
      const token = String(args[0]);
      if (!set.has(token)) return 0;
      set.set(token, this.serverTimeMs + Number(args[1]));
      return 1;
    }
    if (script === COPILOT_LEASE_RELEASE_SCRIPT) return set.delete(String(args[0])) ? 1 : 0;
    throw new Error('unexpected Redis script');
  }
  async quit(): Promise<void> {}
}

describe('copilot-sdk distributed subscription lease', () => {
  it('enforces one hard ten-session fleet-wide pool across distinct credentials and ignores the removed override', async () => {
    const original = process.env.COPILOT_SDK_MAX_CONCURRENT;
    process.env.COPILOT_SDK_MAX_CONCURRENT = '99';
    const shared = new SharedRedis();
    const redisFactory = async () => shared;
    try {
      expect(COPILOT_MAX_CONCURRENT).toBe(10);
      const leases = [];
      for (let index = 0; index < 10; index += 1) {
        leases.push(await acquireCopilotLease({ maxWaitMs: 100, redisFactory }));
      }
      expect(shared.entries.values().next().value?.size).toBe(10);
      await expect(acquireCopilotLease({
        maxWaitMs: 12, pollMs: 3, redisFactory,
      })).rejects.toMatchObject({ code: 'copilot_sdk_queue_timeout' });
      await Promise.all(leases.map((lease) => lease.release()));
      const releasedCapacity = await acquireCopilotLease({ maxWaitMs: 100, redisFactory });
      await releasedCapacity.release();
    } finally {
      if (original === undefined) delete process.env.COPILOT_SDK_MAX_CONCURRENT;
      else process.env.COPILOT_SDK_MAX_CONCURRENT = original;
    }
  });

  it('does not trust a forward-jumped worker clock to prune a live lease', async () => {
    const shared = new SharedRedis();
    const redisFactory = async () => shared;
    const leases = [];
    for (let index = 0; index < COPILOT_MAX_CONCURRENT; index += 1) {
      leases.push(await acquireCopilotLease({ maxWaitMs: 100, redisFactory }));
    }
    const controller = new AbortController();
    const realNow = Date.now;
    const clockSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10 * 365 * 24 * 60 * 60 * 1000);
    try {
      const waitingLease = acquireCopilotLease({ maxWaitMs: 10_000, signal: controller.signal, redisFactory });
      setTimeout(() => controller.abort(), 25);
      await expect(waitingLease).rejects.toMatchObject({ name: 'AbortError' });
      expect([...shared.entries.values()][0].size).toBe(COPILOT_MAX_CONCURRENT);
      expect(COPILOT_LEASE_ACQUIRE_SCRIPT).toContain("redis.call('TIME')");
      expect(COPILOT_LEASE_RENEW_SCRIPT).toContain("redis.call('TIME')");
      const lastAcquire = shared.calls.filter((call) => call.script === COPILOT_LEASE_ACQUIRE_SCRIPT).slice(-1)[0];
      expect(lastAcquire.args).toHaveLength(4); // key + ttl + cap + opaque lease ID; no worker timestamp
      expect(lastAcquire.args[1]).toBe(COPILOT_LEASE_TTL_MS);
      expect(lastAcquire.args[2]).toBe(COPILOT_MAX_CONCURRENT);
    } finally {
      clockSpy.mockRestore();
      await Promise.all(leases.map((lease) => lease.release()));
    }
  });

  it('fails with a stable error when REDIS_URL is absent and never targets localhost', async () => {
    const original = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      await expect(acquireCopilotLease({ maxWaitMs: 100 }))
        .rejects.toMatchObject({ code: 'copilot_sdk_redis_url_missing' });
    } finally {
      if (original === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = original;
    }
  });

  it('serializes independent worker clients in the same global pool, regardless of credentials', async () => {
    const shared = new SharedRedis();
    const redisFactory = async () => shared;
    const firstWorker = await acquireCopilotLease({ maxWaitMs: 100, redisFactory });
    const secondWorker = await acquireCopilotLease({ maxWaitMs: 100, redisFactory });
    const differentAccount = await acquireCopilotLease({ maxWaitMs: 100, redisFactory });
    expect(shared.entries.size).toBe(1);
    expect([...shared.entries.values()][0].size).toBe(3);
    await differentAccount.release();
    await firstWorker.release();
    await secondWorker.release();
    const next = await acquireCopilotLease({ maxWaitMs: 100, redisFactory });
    await next.release();
  });

  it('uses the same Redis pool key for concurrent SDK sessions with distinct credentials', async () => {
    const shared = new SharedRedis();
    const previousRoot = process.env.REDBTN_RUN_DIR_ROOT;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sdk-global-pool-'));
    process.env.REDBTN_RUN_DIR_ROOT = root;
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const clients: Array<{ forceStop: ReturnType<typeof vi.fn> }> = [];
    const dependenciesFor = (): CopilotSdkDependencies => {
      const session = {
        sessionId: `session-${clients.length}`,
        on: vi.fn(() => () => undefined),
        sendAndWait: vi.fn(() => new Promise<never>(() => undefined)),
        abort: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
      };
      const client = {
        start: vi.fn(async () => undefined),
        createSession: vi.fn(async () => session),
        stop: vi.fn(async () => []),
        forceStop: vi.fn(async () => undefined),
      };
      clients.push(client);
      return {
        acquireLease: (async (options) => acquireCopilotLease({
          ...options,
          redisFactory: async () => shared,
        })) as never,
        createClient: (() => client as never) as never,
        startBridge: (async () => ({
          mcpConfig: { mcpServers: { redbtn: { command: process.execPath, args: ['/fake/bridge.js'], env: {} } } },
          toolNames: [],
          close: vi.fn(async () => undefined),
        })) as never,
      };
    };
    const runs = controllers.map((controller, index) => runCopilotSdkStep({
      config: { outputField: `data.answer${index}`, userPrompt: 'hello', tools: [], timeoutMs: 10_000 } as never,
      state: { runId: `global-pool-run-${index}`, data: {} },
      neuronCfg: {
        provider: 'copilot-sdk', model: 'gpt-5', secretName: 'COPILOT_GITHUB_TOKEN',
        apiKey: `distinct-placeholder-credential-${index}`,
      },
      neuronId: `account-${index}-neuron`, callRunId: `global-pool-run-${index}`,
      abortSignal: controller.signal, emitUsage: vi.fn(), dependencies: dependenciesFor(),
    }));

    try {
      await vi.waitFor(() => {
        expect(shared.entries.size).toBe(1);
        expect([...shared.entries.values()][0].size).toBe(10);
      });
      expect([...shared.entries.keys()]).toEqual(['redbtn:copilot-sdk:leases']);
      await expect(acquireCopilotLease({
        maxWaitMs: 12,
        pollMs: 3,
        redisFactory: async () => shared,
      })).rejects.toMatchObject({ code: 'copilot_sdk_queue_timeout' });
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(runs.map((run) => expect(run).rejects.toMatchObject({ name: 'AbortError' })));
      fs.rmSync(root, { recursive: true, force: true });
      if (previousRoot === undefined) delete process.env.REDBTN_RUN_DIR_ROOT;
      else process.env.REDBTN_RUN_DIR_ROOT = previousRoot;
    }
  });

  it('observes cancellation before consuming one of the shared session slots', async () => {
    const shared = new SharedRedis();
    const redisFactory = async () => shared;
    const one = await acquireCopilotLease({ maxWaitMs: 100, redisFactory });
    const controller = new AbortController();
    controller.abort();
    await expect(acquireCopilotLease({
      maxWaitMs: 100, signal: controller.signal, redisFactory,
    })).rejects.toMatchObject({ name: 'AbortError' });
    await one.release();
  });

  it('uses one non-secret global lease key', async () => {
    const shared = new SharedRedis();
    const lease = await acquireCopilotLease({ maxWaitMs: 100, redisFactory: async () => shared });
    const key = [...shared.entries.keys()][0];
    expect(key).toBe('redbtn:copilot-sdk:leases');
    await lease.release();
  });
});
