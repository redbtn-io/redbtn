import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideOrphan,
  readRunLiveness,
  hasOwningLock,
  buildTerminalSet,
  markRunTerminal,
  reapOrphanedRuns,
  markInFlightRunsInterrupted,
  getOrphanStaleThresholdMs,
  getOrphanSweepIntervalMs,
  OrphanReaper,
  ORPHAN_REAPED_COLLECTIONS,
  type ReaperDb,
  type ReaperRedis,
  type RunLivenessSnapshot,
} from '../../src/lib/run/orphan-reaper';
import { RunConfig, RunKeys, createInitialRunState } from '../../src/lib/run/types';

// ---------------------------------------------------------------------------
// In-memory fakes
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
const STALE_MS = RunConfig.RUN_ORPHAN_STALE_MS; // 150_000

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}
function date(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

// ---------------------------------------------------------------------------
// decideOrphan (pure)
// ---------------------------------------------------------------------------

describe('decideOrphan', () => {
  const snap = (o: Partial<RunLivenessSnapshot>): RunLivenessSnapshot => ({
    stateFound: true,
    isStale: false,
    ...o,
  });

  it('reaps when Redis run-state is missing (owning process gone)', () => {
    expect(decideOrphan(snap({ stateFound: false, isStale: true }), false).reap).toBe(true);
    // Lock presence is irrelevant when there is no state at all.
    expect(decideOrphan(snap({ stateFound: false, isStale: true }), true).reap).toBe(true);
  });

  it('keeps a live actively-progressing run (fresh heartbeat)', () => {
    const d = decideOrphan(snap({ stateFound: true, isStale: false }), false);
    expect(d.reap).toBe(false);
    expect(d.reason).toMatch(/fresh/);
  });

  it('keeps a live-but-idle run (stale heartbeat but owning lock present)', () => {
    const d = decideOrphan(snap({ stateFound: true, isStale: true }), true);
    expect(d.reap).toBe(false);
    expect(d.reason).toMatch(/live-but-idle/);
  });

  it('reaps a stale run with no owning process (lock expired)', () => {
    const d = decideOrphan(snap({ stateFound: true, isStale: true }), false);
    expect(d.reap).toBe(true);
    expect(d.reason).toMatch(/no owning process/);
  });
});

// ---------------------------------------------------------------------------
// readRunLiveness
// ---------------------------------------------------------------------------

describe('readRunLiveness', () => {
  it('classifies a fresh heartbeat as alive and extracts conversationId', async () => {
    const state = createInitialRunState({
      runId: 'run-fresh',
      userId: 'u',
      graphId: 'g',
      graphName: 'G',
      input: {},
      conversationId: 'conv-1',
    });
    state.lastProgressAt = iso(-10_000); // 10s ago
    const redis = makeRedis({ [RunKeys.state('run-fresh')]: state });

    const snap = await readRunLiveness(redis, 'run-fresh', { now: NOW, staleAfterMs: STALE_MS });
    expect(snap).toMatchObject({ stateFound: true, isStale: false, conversationId: 'conv-1' });
  });

  it('classifies an old heartbeat as stale', async () => {
    const state = createInitialRunState({ runId: 'run-stale', userId: 'u', graphId: 'g', graphName: 'G', input: {} });
    state.lastProgressAt = iso(-STALE_MS - 1000);
    const redis = makeRedis({ [RunKeys.state('run-stale')]: state });

    const snap = await readRunLiveness(redis, 'run-stale', { now: NOW, staleAfterMs: STALE_MS });
    expect(snap.stateFound).toBe(true);
    expect(snap.isStale).toBe(true);
  });

  it('treats missing run-state as stale + not found', async () => {
    const redis = makeRedis();
    const snap = await readRunLiveness(redis, 'ghost', { now: NOW, staleAfterMs: STALE_MS });
    expect(snap).toEqual({ stateFound: false, isStale: true });
  });

  it('treats a corrupt state blob as stale', async () => {
    const redis = makeRedis({ [RunKeys.state('bad')]: '{not json' });
    const snap = await readRunLiveness(redis, 'bad', { now: NOW, staleAfterMs: STALE_MS });
    expect(snap).toEqual({ stateFound: true, isStale: true });
  });
});

// ---------------------------------------------------------------------------
// hasOwningLock
// ---------------------------------------------------------------------------

describe('hasOwningLock', () => {
  it('detects a base conversation lock', async () => {
    const redis = makeRedis({ [RunKeys.lock('conv-1')]: 'token' });
    expect(await hasOwningLock(redis, 'conv-1')).toBe(true);
  });

  it('detects an agent-scoped lock', async () => {
    const redis = makeRedis({ [RunKeys.lock('conv-1', 'agent-9')]: 'token' });
    expect(await hasOwningLock(redis, 'conv-1')).toBe(true);
  });

  it('returns false when no lock exists', async () => {
    const redis = makeRedis({ [RunKeys.lock('other-conv')]: 'token' });
    expect(await hasOwningLock(redis, 'conv-1')).toBe(false);
  });

  it('does not over-match a different conversation with a shared prefix', async () => {
    // conv-1 must NOT be considered locked just because conv-12 is locked.
    const redis = makeRedis({ [RunKeys.lock('conv-12')]: 'token' });
    expect(await hasOwningLock(redis, 'conv-1')).toBe(false);
  });

  it('fails SAFE (reports present) when Redis errors', async () => {
    const redis = makeRedis();
    (redis.exists as any) = vi.fn(async () => {
      throw new Error('redis down');
    });
    expect(await hasOwningLock(redis, 'conv-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildTerminalSet
// ---------------------------------------------------------------------------

describe('buildTerminalSet', () => {
  it('omits the error field for runEvents (schema has none) and stamps updatedAt', () => {
    const set = buildTerminalSet('runEvents', 'interrupted', 'reason', NOW);
    expect(set).toEqual({ status: 'interrupted', completedAt: NOW, updatedAt: NOW });
  });

  it('records the reason on automationruns/generations', () => {
    expect(buildTerminalSet('automationruns', 'interrupted', 'reason', NOW)).toEqual({
      status: 'interrupted',
      completedAt: NOW,
      error: 'reason',
    });
  });
});

// ---------------------------------------------------------------------------
// markRunTerminal
// ---------------------------------------------------------------------------

describe('markRunTerminal', () => {
  it('flips durable stores with a status guard and cleans Redis run + lock keys', async () => {
    const state = createInitialRunState({
      runId: 'run-x',
      userId: 'u',
      graphId: 'g',
      graphName: 'G',
      input: {},
      conversationId: 'conv-x',
    });
    const redis = makeRedis({
      [RunKeys.state('run-x')]: state,
      [RunKeys.shared('run-x')]: '{}',
      [RunKeys.autoState('run-x')]: '{}',
      [RunKeys.conversationRun('conv-x')]: 'run-x',
      [RunKeys.lock('conv-x')]: 'token',
    });
    const db = makeDb({
      runEvents: [{ runId: 'run-x', status: 'running' }],
      automationruns: [{ runId: 'run-x', status: 'running' }],
    });

    const res = await markRunTerminal({ redis, db, runId: 'run-x', reason: 'orphan', now: NOW });

    expect(res.durableModified).toBe(2);
    expect(res.redisCleaned).toBe(true);
    // durable docs flipped
    expect(db.state.runEvents.docs[0].status).toBe('interrupted');
    expect(db.state.automationruns.docs[0].status).toBe('interrupted');
    // status guard present on the update filter
    expect(db.state.runEvents.updateManyCalls[0].filter).toEqual({
      runId: 'run-x',
      status: { $in: ['pending', 'queued', 'running'] },
    });
    // Redis: run-state rewritten terminal, ancillary + lock keys deleted
    const terminal = JSON.parse(redis.store.get(RunKeys.state('run-x'))!);
    expect(terminal.status).toBe('interrupted');
    expect(redis.store.has(RunKeys.shared('run-x'))).toBe(false);
    expect(redis.store.has(RunKeys.autoState('run-x'))).toBe(false);
    expect(redis.store.has(RunKeys.conversationRun('conv-x'))).toBe(false);
    expect(redis.store.has(RunKeys.lock('conv-x'))).toBe(false);
  });

  it('reads conversationId from run-state when not supplied', async () => {
    const state = createInitialRunState({
      runId: 'run-y',
      userId: 'u',
      graphId: 'g',
      graphName: 'G',
      input: {},
      conversationId: 'conv-y',
    });
    const redis = makeRedis({
      [RunKeys.state('run-y')]: state,
      [RunKeys.lock('conv-y')]: 'token',
    });
    const db = makeDb({ runEvents: [{ runId: 'run-y', status: 'running' }] });

    await markRunTerminal({ redis, db, runId: 'run-y', reason: 'orphan', now: NOW });
    expect(redis.store.has(RunKeys.lock('conv-y'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reapOrphanedRuns — the sweep
// ---------------------------------------------------------------------------

describe('reapOrphanedRuns', () => {
  it('reaps a backlog orphan whose Redis state has TTL-expired (missing)', async () => {
    const redis = makeRedis(); // no run-state at all
    const db = makeDb({ runEvents: [{ runId: 'old-1', status: 'running', startedAt: date(-3_600_000) }] });

    const res = await reapOrphanedRuns({ redis, db, now: NOW, staleAfterMs: STALE_MS });
    expect(res.reaped).toBe(1);
    expect(db.state.runEvents.docs[0].status).toBe('interrupted');
  });

  it('reaps a recently-dead orphan (stale heartbeat, no lock)', async () => {
    const state = createInitialRunState({
      runId: 'dead-1',
      userId: 'u',
      graphId: 'g',
      graphName: 'G',
      input: {},
      conversationId: 'conv-dead',
    });
    state.lastProgressAt = iso(-STALE_MS - 5000);
    const redis = makeRedis({ [RunKeys.state('dead-1')]: state }); // NO lock key
    const db = makeDb({ runEvents: [{ runId: 'dead-1', status: 'running', startedAt: date(-600_000) }] });

    const res = await reapOrphanedRuns({ redis, db, now: NOW, staleAfterMs: STALE_MS });
    expect(res.reaped).toBe(1);
    expect(res.details[0]).toMatchObject({ runId: 'dead-1' });
  });

  it('NEVER reaps a live actively-progressing run (fresh heartbeat)', async () => {
    const state = createInitialRunState({
      runId: 'live-1',
      userId: 'u',
      graphId: 'g',
      graphName: 'G',
      input: {},
      conversationId: 'conv-live',
    });
    state.lastProgressAt = iso(-5000); // 5s ago — actively progressing
    const redis = makeRedis({ [RunKeys.state('live-1')]: state });
    // startedAt is old (long-running), so it passes the age gate and is a candidate.
    const db = makeDb({ runEvents: [{ runId: 'live-1', status: 'running', startedAt: date(-7_200_000) }] });

    const res = await reapOrphanedRuns({ redis, db, now: NOW, staleAfterMs: STALE_MS });
    expect(res.reaped).toBe(0);
    expect(res.kept).toBe(1);
    expect(db.state.runEvents.docs[0].status).toBe('running');
  });

  it('NEVER reaps a live-but-idle run whose owning process still holds the lock', async () => {
    const state = createInitialRunState({
      runId: 'idle-1',
      userId: 'u',
      graphId: 'g',
      graphName: 'G',
      input: {},
      conversationId: 'conv-idle',
    });
    state.lastProgressAt = iso(-STALE_MS - 5000); // stale heartbeat...
    const redis = makeRedis({
      [RunKeys.state('idle-1')]: state,
      [RunKeys.lock('conv-idle')]: 'token', // ...but owning process alive (lock held)
    });
    const db = makeDb({ runEvents: [{ runId: 'idle-1', status: 'running', startedAt: date(-1_800_000) }] });

    const res = await reapOrphanedRuns({ redis, db, now: NOW, staleAfterMs: STALE_MS });
    expect(res.reaped).toBe(0);
    expect(res.kept).toBe(1);
    expect(db.state.runEvents.docs[0].status).toBe('running');
  });

  it('applies the age gate: young runs are never candidates', async () => {
    const redis = makeRedis();
    const db = makeDb({ runEvents: [{ runId: 'young-1', status: 'running', startedAt: date(-1000) }] });

    const res = await reapOrphanedRuns({ redis, db, now: NOW, staleAfterMs: STALE_MS });
    // The find filter must gate on startedAt < (now - staleMs); the young doc
    // does not match, so nothing is scanned or reaped.
    expect(res.scanned).toBe(0);
    expect(res.reaped).toBe(0);
    const findFilter = db.state.runEvents.findCalls[0].filter as any;
    expect(findFilter.status).toBe('running');
    expect(findFilter.startedAt.$lt.getTime()).toBe(NOW.getTime() - STALE_MS);
  });

  it('dedupes a runId that appears in multiple collections', async () => {
    const redis = makeRedis(); // missing state → orphan
    const db = makeDb({
      runEvents: [{ runId: 'dup-1', status: 'running', startedAt: date(-3_600_000) }],
      automationruns: [{ runId: 'dup-1', status: 'running', startedAt: date(-3_600_000) }],
    });

    const res = await reapOrphanedRuns({ redis, db, now: NOW, staleAfterMs: STALE_MS });
    expect(res.scanned).toBe(1); // deduped
    expect(res.reaped).toBe(1);
    // both collections still flipped by markRunTerminal
    expect(db.state.runEvents.docs[0].status).toBe('interrupted');
    expect(db.state.automationruns.docs[0].status).toBe('interrupted');
  });
});

// ---------------------------------------------------------------------------
// markInFlightRunsInterrupted (SIGTERM path)
// ---------------------------------------------------------------------------

describe('markInFlightRunsInterrupted', () => {
  it('publishes run_interrupted then marks durable stores for each entry', async () => {
    const redis = makeRedis();
    const db = makeDb({ runEvents: [{ runId: 'a', status: 'running' }, { runId: 'b', status: 'running' }] });
    const interruptA = vi.fn(async () => {});
    const interruptB = vi.fn(async () => {});

    const marked = await markInFlightRunsInterrupted({
      redis,
      db,
      reason: 'engine shutdown',
      now: NOW,
      entries: [
        { runId: 'a', publisher: { interrupt: interruptA } },
        { runId: 'b', publisher: { interrupt: interruptB } },
      ],
    });

    expect(marked).toBe(2);
    expect(interruptA).toHaveBeenCalledWith('engine shutdown');
    expect(interruptB).toHaveBeenCalledWith('engine shutdown');
    expect(db.state.runEvents.docs.every((d) => d.status === 'interrupted')).toBe(true);
  });

  it('continues past an entry whose publisher.interrupt throws', async () => {
    const redis = makeRedis();
    const db = makeDb({ runEvents: [{ runId: 'a', status: 'running' }, { runId: 'b', status: 'running' }] });
    const marked = await markInFlightRunsInterrupted({
      redis,
      db,
      reason: 'r',
      now: NOW,
      entries: [
        { runId: 'a', publisher: { interrupt: vi.fn(async () => { throw new Error('boom'); }) } },
        { runId: 'b' },
      ],
    });
    // Both still marked terminal in the durable store despite the throw.
    expect(marked).toBe(2);
    expect(db.state.runEvents.docs.every((d) => d.status === 'interrupted')).toBe(true);
  });

  it('still succeeds when the db handle is null (durable marking skipped)', async () => {
    const redis = makeRedis();
    const interrupt = vi.fn(async () => {});
    const marked = await markInFlightRunsInterrupted({
      redis,
      db: null,
      reason: 'r',
      now: NOW,
      entries: [{ runId: 'a', publisher: { interrupt } }],
    });
    expect(marked).toBe(1);
    expect(interrupt).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// env thresholds
// ---------------------------------------------------------------------------

describe('threshold env parsing', () => {
  const saved = { stale: process.env.RUN_ORPHAN_STALE_MS, interval: process.env.RUN_ORPHAN_SWEEP_INTERVAL_MS };
  afterEach(() => {
    process.env.RUN_ORPHAN_STALE_MS = saved.stale;
    process.env.RUN_ORPHAN_SWEEP_INTERVAL_MS = saved.interval;
  });

  it('defaults to RunConfig values', () => {
    delete process.env.RUN_ORPHAN_STALE_MS;
    delete process.env.RUN_ORPHAN_SWEEP_INTERVAL_MS;
    expect(getOrphanStaleThresholdMs()).toBe(RunConfig.RUN_ORPHAN_STALE_MS);
    expect(getOrphanSweepIntervalMs()).toBe(RunConfig.RUN_ORPHAN_SWEEP_INTERVAL_MS);
  });

  it('honours positive env overrides and ignores invalid ones', () => {
    process.env.RUN_ORPHAN_STALE_MS = '90000';
    expect(getOrphanStaleThresholdMs()).toBe(90000);
    process.env.RUN_ORPHAN_STALE_MS = 'not-a-number';
    expect(getOrphanStaleThresholdMs()).toBe(RunConfig.RUN_ORPHAN_STALE_MS);
    process.env.RUN_ORPHAN_STALE_MS = '-5';
    expect(getOrphanStaleThresholdMs()).toBe(RunConfig.RUN_ORPHAN_STALE_MS);
  });
});

// ---------------------------------------------------------------------------
// OrphanReaper lifecycle
// ---------------------------------------------------------------------------

describe('OrphanReaper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('startupReconcile ensures indexes and runs one sweep', async () => {
    const redis = makeRedis();
    const db = makeDb({ runEvents: [{ runId: 'o1', status: 'running', startedAt: date(-3_600_000) }] });
    const reaper = new OrphanReaper({
      redis,
      getDb: async () => db,
      staleAfterMs: STALE_MS,
      intervalMs: 60_000,
      now: () => NOW,
    });

    await reaper.startupReconcile();
    expect(db.state.runEvents.docs[0].status).toBe('interrupted');
    expect(db.state.runEvents.createIndexCalls[0]).toEqual({ status: 1, startedAt: 1 });
  });

  it('start() schedules a periodic sweep; stop() clears it', async () => {
    const redis = makeRedis();
    let sweeps = 0;
    const db = makeDb({});
    const reaper = new OrphanReaper({
      redis,
      getDb: async () => {
        sweeps++;
        return db;
      },
      intervalMs: 1000,
      staleAfterMs: STALE_MS,
      now: () => NOW,
    });

    reaper.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweeps).toBeGreaterThanOrEqual(2);
    reaper.stop();
    const at = sweeps;
    await vi.advanceTimersByTimeAsync(3000);
    expect(sweeps).toBe(at); // no more sweeps after stop
  });

  it('markShutdownInFlight resolves the db and marks the supplied runs', async () => {
    const redis = makeRedis();
    const db = makeDb({ runEvents: [{ runId: 'x', status: 'running' }] });
    const reaper = new OrphanReaper({ redis, getDb: async () => db, now: () => NOW });
    const interrupt = vi.fn(async () => {});
    const marked = await reaper.markShutdownInFlight([{ runId: 'x', publisher: { interrupt } }], 'shutdown');
    expect(marked).toBe(1);
    expect(interrupt).toHaveBeenCalledWith('shutdown');
    expect(db.state.runEvents.docs[0].status).toBe('interrupted');
  });
});
