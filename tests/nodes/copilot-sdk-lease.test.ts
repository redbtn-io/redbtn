import { describe, expect, it } from 'vitest';
import {
  acquireCopilotLease,
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
  it('serializes independent worker clients fleet-wide by credential and releases safely', async () => {
    const shared = new SharedRedis();
    const redisFactory = async () => shared;
    const first = await acquireCopilotLease({ credential: 'same-placeholder-token', maxWaitMs: 100, redisFactory });
    await expect(acquireCopilotLease({
      credential: 'same-placeholder-token', maxWaitMs: 12, pollMs: 3, redisFactory,
    })).rejects.toMatchObject({ code: 'copilot_sdk_queue_timeout' });

    // A different subscription has an independent capacity bucket.
    const other = await acquireCopilotLease({ credential: 'other-placeholder-token', maxWaitMs: 100, redisFactory });
    await other.release();
    await first.release();
    const next = await acquireCopilotLease({ credential: 'same-placeholder-token', maxWaitMs: 100, redisFactory });
    await next.release();
  });

  it('defaults to one shared slot and refuses to degrade to process-local admission', async () => {
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
