import { describe, expect, it, vi } from 'vitest';
import {
  findOrphanedRuns,
  hasRecoveryClaim,
  reapOrphanedRuns,
  ORPHAN_REAPED_COLLECTIONS,
  type ReaperDb,
  type ReaperRedis,
} from '../../src/lib/run/orphan-reaper';
import { RunConfig, RunKeys, createInitialRunState } from '../../src/lib/run/types';

// ---------------------------------------------------------------------------
// In-memory fakes (mirror tests/run-progress/orphan-reaper.test.ts)
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

interface FakeRedis extends ReaperRedis {
  store: Map<string, string>;
}

function makeRedis(seed: Record<string, unknown> = {}): FakeRedis {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(seed)) {
    store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }),
    exists: vi.fn(async (...keys: string[]) => keys.reduce((n, k) => n + (store.has(k) ? 1 : 0), 0)),
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      const re = globToRegExp(pattern);
      const matched = [...store.keys()].filter((k) => re.test(k));
      return ['0', matched] as [string, string[]];
    }),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, arg: string) => {
      if (store.get(key) === arg) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  } as unknown as FakeRedis;
}

interface FakeCollectionState {
  docs: any[];
  findCalls: Array<{ filter: Record<string, unknown>; options?: Record<string, unknown> }>;
  updateManyCalls: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }>;
  createIndexCalls: Array<Record<string, number>>;
}

interface FakeDb extends ReaperDb {
  state: Record<string, FakeCollectionState>;
}

function matchesFilter(doc: any, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    const value = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('$lt' in c && !(value != null && value < (c.$lt as any))) return false;
      if ('$in' in c && !(c.$in as unknown[]).includes(value)) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function makeDb(collections: Record<string, any[]>): FakeDb {
  const state: Record<string, FakeCollectionState> = {};
  for (const name of ORPHAN_REAPED_COLLECTIONS) {
    state[name] = { docs: collections[name] ?? [], findCalls: [], updateManyCalls: [], createIndexCalls: [] };
  }
  return {
    state,
    collection(name: string) {
      const cs = state[name] ?? (state[name] = { docs: [], findCalls: [], updateManyCalls: [], createIndexCalls: [] });
      return {
        find(filter: Record<string, unknown>, options?: Record<string, unknown>) {
          cs.findCalls.push({ filter, options });
          const rows = cs.docs.filter((d) => matchesFilter(d, filter));
          return { toArray: async () => rows };
        },
        updateMany: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          cs.updateManyCalls.push({ filter, update });
          let modified = 0;
          for (const doc of cs.docs) {
            if (matchesFilter(doc, filter)) {
              Object.assign(doc, (update as any).$set);
              modified++;
            }
          }
          return { matchedCount: modified, modifiedCount: modified };
        }),
        createIndex: vi.fn(async (keys: Record<string, number>) => {
          cs.createIndexCalls.push(keys);
          return 'idx';
        }),
      };
    },
  } as unknown as FakeDb;
}

const NOW = new Date('2026-07-16T04:00:00.000Z');
const STALE_MS = RunConfig.RUN_ORPHAN_STALE_MS;

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}
function date(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

// ---------------------------------------------------------------------------
// findOrphanedRuns — decision-only detection (no side effects)
// ---------------------------------------------------------------------------

describe('findOrphanedRuns', () => {
  it('reports a dead orphan (missing run-state) WITHOUT marking it terminal', async () => {
    const redis = makeRedis(); // no run-state
    const db = makeDb({ runEvents: [{ runId: 'dead-1', status: 'running', startedAt: date(-3_600_000) }] });

    const res = await findOrphanedRuns({ redis, db, now: NOW, staleAfterMs: STALE_MS });

    expect(res.orphans.map((o) => o.runId)).toEqual(['dead-1']);
    // No mutation happened — the durable doc is still 'running'.
    expect(db.state.runEvents.docs[0].status).toBe('running');
    expect(db.state.runEvents.updateManyCalls.length).toBe(0);
  });

  it('surfaces the run-state conversationId so a re-dispatch can re-lock', async () => {
    const state = createInitialRunState({
      runId: 'dead-2',
      userId: 'u',
      graphId: 'g',
      graphName: 'G',
      input: {},
      conversationId: 'conv-authoritative',
    });
    state.lastProgressAt = iso(-STALE_MS - 5000);
    const redis = makeRedis({ [RunKeys.state('dead-2')]: state }); // no lock
    const db = makeDb({ runEvents: [{ runId: 'dead-2', status: 'running', startedAt: date(-600_000), conversationId: 'conv-durable' }] });

    const res = await findOrphanedRuns({ redis, db, now: NOW, staleAfterMs: STALE_MS });

    expect(res.orphans).toHaveLength(1);
    expect(res.orphans[0].conversationId).toBe('conv-authoritative');
  });

  it('does NOT report a live actively-progressing run', async () => {
    const state = createInitialRunState({
      runId: 'live-1',
      userId: 'u',
      graphId: 'g',
      graphName: 'G',
      input: {},
      conversationId: 'conv-live',
    });
    state.lastProgressAt = iso(-5000);
    const redis = makeRedis({ [RunKeys.state('live-1')]: state });
    const db = makeDb({ runEvents: [{ runId: 'live-1', status: 'running', startedAt: date(-7_200_000) }] });

    const res = await findOrphanedRuns({ redis, db, now: NOW, staleAfterMs: STALE_MS });

    expect(res.orphans).toHaveLength(0);
    expect(res.kept).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// hasRecoveryClaim
// ---------------------------------------------------------------------------

describe('hasRecoveryClaim', () => {
  it('is true while a recovery claim key is held', async () => {
    const redis = makeRedis({ [RunKeys.recoveryClaim('r1')]: 'boot-abc' });
    expect(await hasRecoveryClaim(redis, 'r1')).toBe(true);
  });

  it('is false with no claim', async () => {
    const redis = makeRedis();
    expect(await hasRecoveryClaim(redis, 'r1')).toBe(false);
  });

  it('fails SAFE (reports claimed) on a Redis error', async () => {
    const redis = makeRedis();
    (redis.exists as any) = vi.fn(async () => {
      throw new Error('redis down');
    });
    expect(await hasRecoveryClaim(redis, 'r1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reapOrphanedRuns — cooperation with requeue-on-boot claims
// ---------------------------------------------------------------------------

describe('reapOrphanedRuns — recovery-claim cooperation', () => {
  it('does NOT reap an orphan currently claimed for requeue-on-boot recovery', async () => {
    const redis = makeRedis({ [RunKeys.recoveryClaim('claimed-1')]: 'boot-xyz' }); // claimed; no run-state
    const db = makeDb({ runEvents: [{ runId: 'claimed-1', status: 'running', startedAt: date(-3_600_000) }] });

    const res = await reapOrphanedRuns({ redis, db, now: NOW, staleAfterMs: STALE_MS });

    expect(res.reaped).toBe(0);
    expect(res.kept).toBe(1); // counted as kept (kept-for-recovery)
    // The claimed run is LEFT running for the recovering engine.
    expect(db.state.runEvents.docs[0].status).toBe('running');
  });

  it('still reaps an unclaimed dead orphan (unchanged behaviour)', async () => {
    const redis = makeRedis(); // no claim, no run-state
    const db = makeDb({ runEvents: [{ runId: 'dead-1', status: 'running', startedAt: date(-3_600_000) }] });

    const res = await reapOrphanedRuns({ redis, db, now: NOW, staleAfterMs: STALE_MS });

    expect(res.reaped).toBe(1);
    expect(db.state.runEvents.docs[0].status).toBe('interrupted');
  });
});
