/**
 * desktop-presence — the liveness probe behind the push-session `ENV_OFFLINE`
 * fence.
 *
 * The thing under test is a CONTRACT WITH ANOTHER REPO: the webapp's
 * `/ws/desktop` gateway writes `desktop:presence:{userId}:{installId}` (keyed by
 * userId + installId, NOT by environmentId), and every assertion about the key
 * string here is what stops a rename on either side from silently turning the
 * fence into a permanent "offline" or a permanent "online".
 *
 * The other half is the degrade ladder. A probe must never fail a healthy run,
 * so anything it cannot answer resolves to `unknown`, and callers treat
 * `unknown` as online.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  probeDesktopPresence,
  presenceKey,
  PRESENCE_PREFIX,
  PRESENCE_TTL_SECONDS,
  PRESENCE_STALE_MS,
  type PresenceRedis,
} from '../../src/lib/environments/desktop-presence';

/** A fake ioredis that answers EXISTS from a set of keys, recording what it was asked. */
function fakeRedis(keys: string[]): { redis: PresenceRedis; asked: string[]; disconnects: number } {
  const asked: string[] = [];
  const state = { disconnects: 0 };
  const redis: PresenceRedis = {
    async exists(key: string) {
      asked.push(key);
      return keys.includes(key) ? 1 : 0;
    },
    disconnect() {
      state.disconnects += 1;
    },
  };
  return {
    redis,
    asked,
    get disconnects() {
      return state.disconnects;
    },
  };
}

const KEY = 'desktop:presence:user_1:cli-abc';

describe('presenceKey', () => {
  it('matches the gateway format: prefix + userId + ":" + installId', () => {
    expect(PRESENCE_PREFIX).toBe('desktop:presence:');
    expect(presenceKey('user_1', 'cli-abc')).toBe(KEY);
  });
});

describe('probeDesktopPresence', () => {
  it('a live presence key is online, and the probe asks for exactly that key', async () => {
    const f = fakeRedis([KEY]);
    const r = await probeDesktopPresence({ userId: 'user_1', installId: 'cli-abc' }, () => f.redis);
    expect(r).toEqual({ verdict: 'online', source: 'redis' });
    expect(f.asked).toEqual([KEY]);
  });

  it('a missing key is offline even when lastSeenAt is fresh — Redis is authoritative', async () => {
    const f = fakeRedis([]);
    const r = await probeDesktopPresence(
      { userId: 'user_1', installId: 'cli-abc', lastSeenAt: new Date(Date.now() - 4_000) },
      () => f.redis,
    );
    expect(r.verdict).toBe('offline');
    expect(r.source).toBe('redis');
    expect(r.offlineForSeconds).toBe(4);
  });

  it('a missing key with no lastSeenAt reports the gateway TTL as the lower bound', async () => {
    const f = fakeRedis([]);
    const r = await probeDesktopPresence({ userId: 'user_1', installId: 'cli-abc' }, () => f.redis);
    expect(r.verdict).toBe('offline');
    expect(r.offlineForSeconds).toBe(PRESENCE_TTL_SECONDS);
  });

  it('a Redis failure falls back to lastSeenAt: stale → offline', async () => {
    const boom: PresenceRedis = {
      exists: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const r = await probeDesktopPresence(
      { userId: 'user_1', installId: 'cli-abc', lastSeenAt: new Date(Date.now() - (PRESENCE_STALE_MS + 30_000)) },
      () => boom,
    );
    expect(r).toMatchObject({ verdict: 'offline', source: 'lastSeenAt' });
    expect(r.offlineForSeconds).toBeGreaterThanOrEqual(120);
  });

  it('a Redis failure falls back to lastSeenAt: fresh → online', async () => {
    const boom: PresenceRedis = {
      exists: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const r = await probeDesktopPresence(
      { userId: 'user_1', installId: 'cli-abc', lastSeenAt: new Date(Date.now() - 1_000) },
      () => boom,
    );
    expect(r).toEqual({ verdict: 'online', source: 'lastSeenAt' });
  });

  it('a Redis failure with nothing to fall back on is unknown, never offline', async () => {
    const boom: PresenceRedis = {
      exists: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const r = await probeDesktopPresence({ userId: 'user_1', installId: 'cli-abc' }, () => boom);
    expect(r).toEqual({ verdict: 'unknown', source: 'unavailable' });
  });

  it('a factory that throws outright is unknown, not a thrown probe', async () => {
    const r = await probeDesktopPresence({ userId: 'user_1', installId: 'cli-abc' }, () => {
      throw new Error('ioredis missing');
    });
    expect(r.verdict).toBe('unknown');
  });

  it('no installId (an SSH-shaped env, or a doc that never registered) is unknown and touches no Redis', async () => {
    const factory = vi.fn();
    const r = await probeDesktopPresence({ userId: 'user_1', installId: '  ' }, factory);
    expect(r).toEqual({ verdict: 'unknown', source: 'unavailable' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('disconnects the client it opened, on both the hit and the miss path', async () => {
    const hit = fakeRedis([KEY]);
    await probeDesktopPresence({ userId: 'user_1', installId: 'cli-abc' }, () => hit.redis);
    expect(hit.disconnects).toBe(1);

    const miss = fakeRedis([]);
    await probeDesktopPresence({ userId: 'user_1', installId: 'cli-abc' }, () => miss.redis);
    expect(miss.disconnects).toBe(1);
  });
});
