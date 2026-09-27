import { describe, expect, it } from 'vitest';
import {
  acquireCopilotLease,
  COPILOT_MAX_CONCURRENT,
  COPILOT_LEASE_ACQUIRE_SCRIPT,
  COPILOT_LEASE_RELEASE_SCRIPT,
  COPILOT_LEASE_RENEW_SCRIPT,
  type CopilotRedisLeaseClient,
} from '../../src/lib/nodes/universal/executors/copilotSdkLease';

class SharedRedis implements CopilotRedisLeaseClient {
  readonly entries = new Map<string, Map<string, number>>();
  async eval(script: string, _keys: number, key: string, ...args: (string | number)[]): Promise<number> {
    const set = this.entries.get(key) ?? new Map<string, number>();
    this.entries.set(key, set);
    if (script === COPILOT_LEASE_ACQUIRE_SCRIPT) {
      const now = Number(args[0]);
      for (const [token, expires] of set) if (expires <= now) set.delete(token);
      if (set.size >= Number(args[2])) return 0;
      set.set(String(args[3]), Number(args[1]));
      return 1;
    }
    if (script === COPILOT_LEASE_RENEW_SCRIPT) {
      const token = String(args[0]);
      if (!set.has(token)) return 0;
      set.set(token, Number(args[1]));
      return 1;
    }
    if (script === COPILOT_LEASE_RELEASE_SCRIPT) return set.delete(String(args[0])) ? 1 : 0;
    throw new Error('unexpected Redis script');
  }
  async quit(): Promise<void> {}
}

describe('copilot-sdk distributed subscription lease', () => {
  it('enforces a hard ten-session fleet-wide limit, even if the removed env override is set', async () => {
    const original = process.env.COPILOT_SDK_MAX_CONCURRENT;
    process.env.COPILOT_SDK_MAX_CONCURRENT = '99';
    const shared = new SharedRedis();
    const redisFactory = async () => shared;
    try {
      expect(COPILOT_MAX_CONCURRENT).toBe(10);
      const leases = [];
      for (let index = 0; index < 10; index += 1) {
        leases.push(await acquireCopilotLease({ credential: 'hard-limit-token', maxWaitMs: 100, redisFactory }));
      }
      expect(shared.entries.values().next().value?.size).toBe(10);
      await expect(acquireCopilotLease({
        credential: 'hard-limit-token', maxWaitMs: 12, pollMs: 3, redisFactory,
      })).rejects.toMatchObject({ code: 'copilot_sdk_queue_timeout' });
      await Promise.all(leases.map((lease) => lease.release()));
      const releasedCapacity = await acquireCopilotLease({ credential: 'hard-limit-token', maxWaitMs: 100, redisFactory });
      await releasedCapacity.release();
    } finally {
      if (original === undefined) delete process.env.COPILOT_SDK_MAX_CONCURRENT;
      else process.env.COPILOT_SDK_MAX_CONCURRENT = original;
    }
  });

  it('fails with a stable error when REDIS_URL is absent and never targets localhost', async () => {
    const original = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      await expect(acquireCopilotLease({ credential: 'placeholder', maxWaitMs: 100 }))
        .rejects.toMatchObject({ code: 'copilot_sdk_redis_url_missing' });
    } finally {
      if (original === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = original;
    }
  });

  it('serializes independent worker clients fleet-wide by credential and releases safely', async () => {
    const shared = new SharedRedis();
    const redisFactory = async () => shared;
    const first = await acquireCopilotLease({ credential: 'same-placeholder-token', maxWaitMs: 100, redisFactory });
    const second = await acquireCopilotLease({ credential: 'same-placeholder-token', maxWaitMs: 100, redisFactory });

    // A different subscription has an independent capacity bucket.
    const other = await acquireCopilotLease({ credential: 'other-placeholder-token', maxWaitMs: 100, redisFactory });
    expect([...shared.entries.values()].map((members) => members.size).sort()).toEqual([1, 2]);
    await other.release();
    await first.release();
    await second.release();
    const next = await acquireCopilotLease({ credential: 'same-placeholder-token', maxWaitMs: 100, redisFactory });
    await next.release();
  });

  it('observes cancellation before consuming one of the shared session slots', async () => {
    const shared = new SharedRedis();
    const redisFactory = async () => shared;
    const one = await acquireCopilotLease({ credential: 'token', maxWaitMs: 100, redisFactory });
    const controller = new AbortController();
    controller.abort();
    await expect(acquireCopilotLease({
      credential: 'token', maxWaitMs: 100, signal: controller.signal, redisFactory,
    })).rejects.toMatchObject({ name: 'AbortError' });
    await one.release();
  });

  it('uses a hashed credential in the lease key, never the raw token', async () => {
    const shared = new SharedRedis();
    const lease = await acquireCopilotLease({ credential: 'do-not-store-this', maxWaitMs: 100, redisFactory: async () => shared });
    const key = [...shared.entries.keys()][0];
    expect(key).toMatch(/^redbtn:copilot-sdk:leases:[a-f0-9]{64}$/);
    expect(key).not.toContain('do-not-store-this');
    await lease.release();
  });
});
