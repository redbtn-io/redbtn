import { describe, expect, it } from 'vitest';
import {
  AutomationConcurrencyLimiter,
  ACQUIRE_LUA,
  normalizeAutomationConcurrency,
  resolveEffectiveConcurrency,
  effectiveCap,
  DEFAULT_TRIGGER_ID,
} from '../../src/lib/run/automation-concurrency';
import { RunKeys, RunConfig } from '../../src/lib/run/types';

// ---------------------------------------------------------------------------
// FakeRedis — in-memory sorted-set subset + a special-cased `eval` that mirrors
// ACQUIRE_LUA exactly (repo convention: see run-progress-watchdog.test.ts). The
// mirror runs the SAME algorithm as the Lua so the atomicity/zombie logic under
// test is the production logic, not a re-derivation.
// ---------------------------------------------------------------------------
class FakeRedis {
  private zsets = new Map<string, Map<string, number>>();
  ttls = new Map<string, number>();

  private z(key: string): Map<string, number> {
    let m = this.zsets.get(key);
    if (!m) {
      m = new Map();
      this.zsets.set(key, m);
    }
    return m;
  }

  async zadd(key: string, ...args: unknown[]): Promise<number> {
    let i = 0;
    const flags = new Set<string>();
    const FLAG = ['NX', 'XX', 'GT', 'LT', 'CH', 'INCR'];
    while (i < args.length && typeof args[i] === 'string' && FLAG.includes(String(args[i]).toUpperCase())) {
      flags.add(String(args[i]).toUpperCase());
      i++;
    }
    const m = this.z(key);
    let added = 0;
    for (; i + 1 < args.length; i += 2) {
      const score = Number(args[i]);
      const member = String(args[i + 1]);
      const existing = m.get(member);
      if (flags.has('XX') && existing === undefined) continue;
      if (flags.has('NX') && existing !== undefined) continue;
      if (flags.has('GT') && existing !== undefined && !(score > existing)) continue;
      if (flags.has('LT') && existing !== undefined && !(score < existing)) continue;
      if (existing === undefined) added++;
      m.set(member, score);
    }
    return added;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const s = this.z(key).get(member);
    return s === undefined ? null : String(s);
  }

  async zcard(key: string): Promise<number> {
    return this.z(key).size;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const m = this.z(key);
    let n = 0;
    for (const mem of members) if (m.delete(mem)) n++;
    return n;
  }

  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    const m = this.z(key);
    let n = 0;
    for (const [mem, score] of [...m]) {
      if (score >= lo && score <= hi) {
        m.delete(mem);
        n++;
      }
    }
    return n;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const arr = [...this.z(key)]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      .map((e) => e[0]);
    const s = start < 0 ? arr.length + start : start;
    const e = stop < 0 ? arr.length + stop : stop;
    return arr.slice(s, e + 1);
  }

  async expire(key: string, ttl: number): Promise<number> {
    this.ttls.set(key, ttl);
    return 1;
  }

  async eval(script: string, numKeys: number, ...rest: unknown[]): Promise<unknown> {
    if (script !== ACQUIRE_LUA) throw new Error('FakeRedis.eval: unexpected script');
    const keys = rest.slice(0, numKeys).map(String);
    const argv = rest.slice(numKeys).map(String);
    return this.runAcquire(keys, argv);
  }

  private prune(key: string, cutoff: number): void {
    const m = this.z(key);
    for (const [mem, score] of [...m]) if (score <= cutoff) m.delete(mem);
  }

  private runAcquire(keys: string[], argv: string[]): [number, number, number, number, string[]] {
    const now = Number(argv[0]);
    const cutoff = Number(argv[1]);
    const totalMax = Number(argv[2]);
    const triggerMax = Number(argv[3]);
    const member = argv[4];
    const ttl = Number(argv[5]);
    const totalInterrupt = Number(argv[6]);
    const triggerInterrupt = Number(argv[7]);
    const [k1, k2] = keys;

    this.prune(k1, cutoff);
    this.prune(k2, cutoff);
    const m1 = this.z(k1);
    const m2 = this.z(k2);

    if (m1.has(member)) {
      m1.set(member, now);
      m2.set(member, now);
      this.ttls.set(k1, ttl);
      this.ttls.set(k2, ttl);
      return [1, m1.size, m2.size, 0, []];
    }

    let totalCount = m1.size;
    const triggerCount = m2.size;

    const totalBlock = totalMax >= 0 && totalCount >= totalMax && totalInterrupt === 0;
    const triggerBlock = triggerMax >= 0 && triggerCount >= triggerMax && triggerInterrupt === 0;
    if (totalBlock || triggerBlock) {
      return [0, totalCount, triggerCount, triggerBlock ? 1 : 0, []];
    }

    const interrupted: string[] = [];
    const seen = new Set<string>();
    const oldest = (key: string, n: number): string[] =>
      [...this.z(key)]
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
        .map((e) => e[0])
        .slice(0, n);
    const evict = (fromKey: string, count: number, maxCap: number): void => {
      const need = count - maxCap + 1;
      if (need < 1) return;
      for (const v of oldest(fromKey, need)) {
        if (v !== member && !seen.has(v)) {
          m1.delete(v);
          m2.delete(v);
          seen.add(v);
          interrupted.push(v);
        }
      }
    };

    if (triggerMax >= 0 && triggerInterrupt === 1 && triggerCount >= triggerMax) {
      evict(k2, triggerCount, triggerMax);
      totalCount = m1.size;
    }
    if (totalMax >= 0 && totalInterrupt === 1 && totalCount >= totalMax) {
      evict(k1, totalCount, totalMax);
    }

    m1.set(member, now);
    m2.set(member, now);
    this.ttls.set(k1, ttl);
    this.ttls.set(k2, ttl);
    return [1, m1.size, m2.size, 0, interrupted];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeLimiter() {
  const redis = new FakeRedis();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const limiter = new AutomationConcurrencyLimiter(redis as any);
  return { redis, limiter };
}

const STALE = RunConfig.AUTOMATION_CONCURRENCY_STALE_MS;
const AUTO = 'auto-1';

describe('normalizeAutomationConcurrency', () => {
  it('defaults undefined/null to allow (unlimited) — backward compatible', () => {
    expect(normalizeAutomationConcurrency(undefined)).toEqual({ mode: 'allow' });
    expect(normalizeAutomationConcurrency(null)).toEqual({ mode: 'allow' });
  });

  it('maps legacy bare strings to their pre-numeric behaviour', () => {
    expect(normalizeAutomationConcurrency('allow')).toEqual({ mode: 'allow' });
    expect(normalizeAutomationConcurrency('skip')).toEqual({ mode: 'skip', max: 1 });
    expect(normalizeAutomationConcurrency('queue')).toEqual({ mode: 'queue', max: 1 });
    expect(normalizeAutomationConcurrency('interrupt')).toEqual({ mode: 'interrupt', max: 1 });
  });

  it('accepts the numeric object form', () => {
    expect(normalizeAutomationConcurrency({ mode: 'skip', max: 5 })).toEqual({ mode: 'skip', max: 5 });
    expect(normalizeAutomationConcurrency({ mode: 'queue', max: 3 })).toEqual({ mode: 'queue', max: 3 });
  });

  it('infers skip when a positive max is given without a mode', () => {
    expect(normalizeAutomationConcurrency({ max: 4 })).toEqual({ mode: 'skip', max: 4 });
  });

  it('treats a non-positive/absent max on a blocking mode as the legacy cap of 1', () => {
    expect(normalizeAutomationConcurrency({ mode: 'skip', max: 0 })).toEqual({ mode: 'skip', max: 1 });
    expect(normalizeAutomationConcurrency({ mode: 'skip' })).toEqual({ mode: 'skip', max: 1 });
  });

  it('ignores max for allow mode', () => {
    expect(normalizeAutomationConcurrency({ mode: 'allow', max: 9 })).toEqual({ mode: 'allow' });
    expect(normalizeAutomationConcurrency({ max: 0 })).toEqual({ mode: 'allow' });
  });
});

describe('effectiveCap / resolveEffectiveConcurrency', () => {
  it('effectiveCap: -1 for allow, the max for blocking, 1 for capless blocking', () => {
    expect(effectiveCap({ mode: 'allow' })).toBe(-1);
    expect(effectiveCap({ mode: 'skip', max: 4 })).toBe(4);
    expect(effectiveCap({ mode: 'skip' })).toBe(1);
  });

  it('no per-trigger override → trigger scope is unlimited, only total constrains', () => {
    const r = resolveEffectiveConcurrency({ mode: 'skip', max: 3 });
    expect(r.totalCap).toBe(3);
    expect(r.triggerCap).toBe(-1);
    expect(r.trigger.mode).toBe('skip'); // inherits total mode for reporting
  });

  it('per-trigger override tightens the cap and can override the mode', () => {
    const r = resolveEffectiveConcurrency({ mode: 'skip', max: 5 }, { mode: 'queue', max: 1 });
    expect(r.totalCap).toBe(5);
    expect(r.triggerCap).toBe(1);
    expect(r.trigger.mode).toBe('queue');
  });

  it('per-trigger override without an explicit mode inherits the total mode', () => {
    const r = resolveEffectiveConcurrency({ mode: 'queue', max: 5 }, { max: 2 });
    expect(r.triggerCap).toBe(2);
    expect(r.trigger.mode).toBe('queue');
  });

  it('a per-trigger max is never nullified by an unlimited (allow) total', () => {
    const r = resolveEffectiveConcurrency('allow', { max: 2 });
    expect(r.totalCap).toBe(-1); // total stays unlimited
    expect(r.triggerCap).toBe(2); // this trigger is capped
    expect(r.trigger.mode).toBe('skip'); // sensible default overflow behaviour
  });
});

describe('AutomationConcurrencyLimiter.tryAcquire — atomic total cap', () => {
  it('admits up to the cap then skips (no read-then-check race window)', async () => {
    const { limiter } = makeLimiter();
    const cfg = { concurrency: { mode: 'skip' as const, max: 2 }, automationId: AUTO };

    const a = await limiter.tryAcquire({ ...cfg, runId: 'r1', now: 1000 });
    const b = await limiter.tryAcquire({ ...cfg, runId: 'r2', now: 1001 });
    const c = await limiter.tryAcquire({ ...cfg, runId: 'r3', now: 1002 });

    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(false);
    expect(c.decision).toBe('skip');
    expect(c.blockedBy).toBe('total');
    expect(c.totalActive).toBe(2);
  });

  it('queue mode reports a queue decision when blocked', async () => {
    const { limiter } = makeLimiter();
    const cfg = { concurrency: { mode: 'queue' as const, max: 1 }, automationId: AUTO };
    await limiter.tryAcquire({ ...cfg, runId: 'r1', now: 1000 });
    const b = await limiter.tryAcquire({ ...cfg, runId: 'r2', now: 1001 });
    expect(b.allowed).toBe(false);
    expect(b.decision).toBe('queue');
  });

  it('re-acquiring the same runId is idempotent (does not double-count)', async () => {
    const { limiter } = makeLimiter();
    const cfg = { concurrency: { mode: 'skip' as const, max: 1 }, automationId: AUTO };
    const a = await limiter.tryAcquire({ ...cfg, runId: 'r1', now: 1000 });
    const a2 = await limiter.tryAcquire({ ...cfg, runId: 'r1', now: 1005 });
    expect(a.allowed).toBe(true);
    expect(a2.allowed).toBe(true);
    expect(a2.totalActive).toBe(1);
  });
});

describe('AutomationConcurrencyLimiter.tryAcquire — per-trigger override', () => {
  it('a tight per-trigger cap blocks its trigger while the total still has room', async () => {
    const { limiter } = makeLimiter();
    // total cap 5, trigger A override cap 1.
    const A = {
      automationId: AUTO,
      triggerId: 'tA',
      concurrency: { mode: 'skip' as const, max: 5 },
      triggerConcurrency: { max: 1 },
    };
    const first = await limiter.tryAcquire({ ...A, runId: 'r1', now: 1000 });
    const second = await limiter.tryAcquire({ ...A, runId: 'r2', now: 1001 });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.blockedBy).toBe('trigger');

    // A DIFFERENT trigger under the same automation still has total room.
    const other = await limiter.tryAcquire({
      automationId: AUTO,
      triggerId: 'tB',
      concurrency: { mode: 'skip' as const, max: 5 },
      runId: 'r3',
      now: 1002,
    });
    expect(other.allowed).toBe(true);
    expect(other.totalActive).toBe(2);
  });
});

describe('zombie exclusion (crash resilience) — requirement 2', () => {
  it('a crashed run that stops heartbeating ages out and frees its slot', async () => {
    const { limiter } = makeLimiter();
    const cfg = { concurrency: { mode: 'skip' as const, max: 1 }, automationId: AUTO };

    const T = 1_000_000;
    const a = await limiter.tryAcquire({ ...cfg, runId: 'zombie', now: T });
    expect(a.allowed).toBe(true);

    // Still within the stale window → cap still held.
    const blocked = await limiter.tryAcquire({ ...cfg, runId: 'r2', now: T + 60_000 });
    expect(blocked.allowed).toBe(false);

    // Past the stale window with NO heartbeat from `zombie` → it is pruned and
    // the new run is admitted. (This is exactly the post-crash scenario.)
    const admitted = await limiter.tryAcquire({ ...cfg, runId: 'r2', now: T + STALE + 1 });
    expect(admitted.allowed).toBe(true);
    expect(admitted.totalActive).toBe(1);
  });

  it('a live run that keeps heartbeating never loses its slot', async () => {
    const { limiter } = makeLimiter();
    const cfg = { concurrency: { mode: 'skip' as const, max: 1 }, automationId: AUTO };
    const T = 2_000_000;
    await limiter.tryAcquire({ ...cfg, runId: 'r1', now: T });

    // Heartbeat just before the window would expire.
    await limiter.heartbeat({ automationId: AUTO, runId: 'r1' }, T + STALE - 1);

    // Now, past the ORIGINAL window, r1 is still alive → r2 stays blocked.
    const blocked = await limiter.tryAcquire({ ...cfg, runId: 'r2', now: T + STALE + 1 });
    expect(blocked.allowed).toBe(false);
  });

  it('heartbeat is update-only: it never resurrects a slot that was not acquired', async () => {
    const { limiter } = makeLimiter();
    await limiter.heartbeat({ automationId: AUTO, runId: 'ghost' }, 5000);
    const count = await limiter.countActive({ automationId: AUTO, now: 5001 });
    expect(count).toBe(0);
  });
});

describe('release + countActive (Active-Runs view)', () => {
  it('releasing a slot lets a blocked run in', async () => {
    const { limiter } = makeLimiter();
    const cfg = { concurrency: { mode: 'skip' as const, max: 1 }, automationId: AUTO };
    await limiter.tryAcquire({ ...cfg, runId: 'r1', now: 1000 });
    const blocked = await limiter.tryAcquire({ ...cfg, runId: 'r2', now: 1001 });
    expect(blocked.allowed).toBe(false);

    await limiter.release({ automationId: AUTO, runId: 'r1' });

    const admitted = await limiter.tryAcquire({ ...cfg, runId: 'r2', now: 1002 });
    expect(admitted.allowed).toBe(true);
  });

  it('countActive/listActiveSlots prune phantom runs (never report a dead run)', async () => {
    const { limiter } = makeLimiter();
    const cfg = { concurrency: { mode: 'skip' as const, max: 10 }, automationId: AUTO };
    const T = 3_000_000;
    await limiter.tryAcquire({ ...cfg, runId: 'alive', now: T });
    await limiter.tryAcquire({ ...cfg, runId: 'dead', now: T });
    // keep only `alive` heartbeating
    await limiter.heartbeat({ automationId: AUTO, runId: 'alive' }, T + STALE);

    const now = T + STALE + 1;
    expect(await limiter.countActive({ automationId: AUTO, now })).toBe(1);
    expect(await limiter.listActiveSlots({ automationId: AUTO, now })).toEqual(['alive']);
  });
});

describe('allow + interrupt modes', () => {
  it('allow never blocks but still tracks active runs', async () => {
    const { limiter } = makeLimiter();
    const cfg = { concurrency: 'allow' as const, automationId: AUTO };
    for (const runId of ['r1', 'r2', 'r3', 'r4']) {
      const res = await limiter.tryAcquire({ ...cfg, runId, now: 1000 });
      expect(res.allowed).toBe(true);
      expect(res.decision).toBe('allow');
    }
    expect(await limiter.countActive({ automationId: AUTO, now: 1000 })).toBe(4);
  });

  it('interrupt admits and reports the runIds to cancel', async () => {
    const { limiter } = makeLimiter();
    const cfg = { concurrency: 'interrupt' as const, automationId: AUTO };
    const a = await limiter.tryAcquire({ ...cfg, runId: 'r1', now: 1000 });
    expect(a.allowed).toBe(true);
    expect(a.interruptRunIds).toEqual([]);

    const b = await limiter.tryAcquire({ ...cfg, runId: 'r2', now: 1001 });
    expect(b.allowed).toBe(true);
    expect(b.decision).toBe('interrupt');
    expect(b.interruptRunIds).toEqual(['r1']);
  });
});

describe('interrupt mode — scope-aware, cap-aware, atomic', () => {
  it('a per-trigger interrupt override interrupts its trigger instead of skipping (bug 1)', async () => {
    const { limiter } = makeLimiter();
    const cfg = {
      automationId: AUTO,
      triggerId: 'tA',
      concurrency: { mode: 'allow' as const }, // total unlimited
      triggerConcurrency: { mode: 'interrupt' as const, max: 1 },
    };
    const first = await limiter.tryAcquire({ ...cfg, runId: 'r1', now: 1000 });
    expect(first.allowed).toBe(true);
    expect(first.decision).toBe('interrupt');
    expect(first.interruptRunIds).toEqual([]);

    const second = await limiter.tryAcquire({ ...cfg, runId: 'r2', now: 1001 });
    expect(second.allowed).toBe(true);
    // The bug: this used to come back as 'skip'. It must interrupt r1 and admit r2.
    expect(second.decision).toBe('interrupt');
    expect(second.interruptRunIds).toEqual(['r1']);
    // The trigger scope holds exactly the new run afterwards.
    expect(await limiter.countActive({ automationId: AUTO, triggerId: 'tA', now: 1002 })).toBe(1);
  });

  it('a total interrupt does NOT bypass a per-trigger skip cap (bug 2)', async () => {
    const { limiter } = makeLimiter();
    const base = {
      automationId: AUTO,
      concurrency: { mode: 'interrupt' as const, max: 5 }, // total interrupt, cap 5
    };
    const tA = { ...base, triggerId: 'tA', triggerConcurrency: { mode: 'skip' as const, max: 1 } };

    const first = await limiter.tryAcquire({ ...tA, runId: 'r1', now: 1000 });
    expect(first.allowed).toBe(true);

    // The per-trigger skip-1 cap wins even though the total mode is interrupt.
    const second = await limiter.tryAcquire({ ...tA, runId: 'r2', now: 1001 });
    expect(second.allowed).toBe(false);
    expect(second.decision).toBe('skip');
    expect(second.blockedBy).toBe('trigger');
    // r1 must NOT have been interrupted.
    expect(await limiter.listActiveSlots({ automationId: AUTO, triggerId: 'tA', now: 1002 })).toEqual([
      'r1',
    ]);

    // A different trigger with no override is still bounded only by the total
    // interrupt cap, so it is admitted (with an interrupt decision).
    const other = await limiter.tryAcquire({ ...base, triggerId: 'tB', runId: 'r3', now: 1003 });
    expect(other.allowed).toBe(true);
    expect(other.decision).toBe('interrupt');
  });

  it('interrupt evicts only the oldest runs needed to satisfy the cap (cap-aware)', async () => {
    const { limiter } = makeLimiter();
    const cfg = { automationId: AUTO, concurrency: { mode: 'interrupt' as const, max: 2 } };
    await limiter.tryAcquire({ ...cfg, runId: 'r1', now: 1000 });
    await limiter.tryAcquire({ ...cfg, runId: 'r2', now: 1001 }); // total now at cap 2

    const third = await limiter.tryAcquire({ ...cfg, runId: 'r3', now: 1002 });
    expect(third.allowed).toBe(true);
    expect(third.decision).toBe('interrupt');
    // Old (uncapped) behaviour would interrupt every prior run; cap-2 evicts only r1.
    expect(third.interruptRunIds).toEqual(['r1']);
    expect(third.totalActive).toBe(2); // stays exactly at the cap
    expect(await limiter.listActiveSlots({ automationId: AUTO, now: 1003 })).toEqual(['r2', 'r3']);
  });

  it('total interrupt makes room across triggers by evicting the oldest total run', async () => {
    const { limiter } = makeLimiter();
    const base = { automationId: AUTO, concurrency: { mode: 'interrupt' as const, max: 2 } };
    await limiter.tryAcquire({ ...base, triggerId: 'tA', runId: 'rA1', now: 1000 });
    await limiter.tryAcquire({ ...base, triggerId: 'tA', runId: 'rA2', now: 1001 });

    // total at cap 2 (both under tA); a brand-new trigger tB fires.
    const rb = await limiter.tryAcquire({ ...base, triggerId: 'tB', runId: 'rB1', now: 1002 });
    expect(rb.allowed).toBe(true);
    expect(rb.decision).toBe('interrupt');
    expect(rb.interruptRunIds).toEqual(['rA1']); // oldest total run, from another trigger
    expect(rb.totalActive).toBe(2);
    // The interrupted run is out of the TOTAL scope immediately.
    expect(await limiter.listActiveSlots({ automationId: AUTO, now: 1003 })).toEqual(['rA2', 'rB1']);
  });

  it('mixed interrupt scopes: the tighter per-trigger interrupt cap governs its trigger', async () => {
    const { limiter } = makeLimiter();
    const cfg = {
      automationId: AUTO,
      triggerId: 'tA',
      concurrency: { mode: 'interrupt' as const, max: 5 }, // total interrupt, cap 5
      triggerConcurrency: { mode: 'interrupt' as const, max: 1 }, // trigger interrupt, cap 1
    };
    await limiter.tryAcquire({ ...cfg, runId: 'r1', now: 1000 });
    const r2 = await limiter.tryAcquire({ ...cfg, runId: 'r2', now: 1001 });
    expect(r2.allowed).toBe(true);
    expect(r2.decision).toBe('interrupt');
    // The trigger cap of 1 forces r1's interrupt while the total (cap 5) has room.
    expect(r2.interruptRunIds).toEqual(['r1']);
    expect(r2.triggerActive).toBe(1);
    expect(r2.totalActive).toBe(1);
  });

  it('interrupt reports only live runs as targets — a zombie is pruned, not "interrupted"', async () => {
    const { limiter } = makeLimiter();
    const cfg = { automationId: AUTO, concurrency: { mode: 'interrupt' as const, max: 1 } };
    const T = 5_000_000;
    await limiter.tryAcquire({ ...cfg, runId: 'zombie', now: T }); // holds the only slot

    // Past the stale window with no heartbeat: the same atomic acquire prunes the
    // zombie first, so the new run is admitted WITHOUT interrupting anything. This
    // is the acquire being the single source of truth (no pre-eval read race).
    const fresh = await limiter.tryAcquire({ ...cfg, runId: 'r2', now: T + STALE + 1 });
    expect(fresh.allowed).toBe(true);
    expect(fresh.decision).toBe('interrupt');
    expect(fresh.interruptRunIds).toEqual([]); // zombie was pruned, not interrupted
    expect(fresh.totalActive).toBe(1);
  });
});

describe('key layout', () => {
  it('writes the total slot under the hash-tagged total key', async () => {
    const { redis, limiter } = makeLimiter();
    await limiter.tryAcquire({
      concurrency: { mode: 'skip', max: 2 },
      automationId: AUTO,
      runId: 'r1',
      now: 1000,
    });
    expect(await redis.zscore(RunKeys.automationConcurrencyTotal(AUTO), 'r1')).toBe('1000');
    // No discrete triggerId → default trigger scope.
    expect(
      await redis.zscore(RunKeys.automationConcurrencyTrigger(AUTO, DEFAULT_TRIGGER_ID), 'r1'),
    ).toBe('1000');
  });
});
