import { describe, expect, it, vi } from 'vitest';
import { getActiveRunForConversation } from '../../src/lib/run/run-publisher';
import { RunKeys, createInitialRunState, type RunState } from '../../src/lib/run/types';

// ---------------------------------------------------------------------------
// Ownership-safe conversation-pointer cleanup on the NORMAL lifecycle paths.
//
// The orphan reaper's TOCTOU fix (PR #276) made its pointer cleanup a
// compare-and-delete against the owning runId. The same blind-delete pattern
// lived in run-publisher.ts's normal lifecycle paths (complete/fail/interrupt,
// publishRunError, getActiveRunForConversation): a run that reads/owns the
// `run:conversation:{id}` pointer, decides to clear it, then unconditionally
// DELs it — wiping a fresh acquirer's live pointer if one raced in between.
//
// All of those now route through releaseConversationPointerIfOwner (a Lua
// compare-and-delete, thoroughly unit-tested in orphan-reaper.test.ts). This
// suite pins the behavior of getActiveRunForConversation, the one lifecycle
// site whose stale-clear reads the runId itself (so the read↔delete window is
// real) and which is trivially constructable without a full RunPublisher.
// ---------------------------------------------------------------------------

interface FakeRedis {
  store: Map<string, string>;
  /** One-shot GET overrides: [key, value] consumed on the next matching GET. */
  pendingReads: Array<[string, string]>;
  get: (key: string) => Promise<string | null>;
  del: (...keys: string[]) => Promise<number>;
  eval: (script: string, numKeys: number, key: string, arg: string) => Promise<number>;
}

function makeRedis(seed: Record<string, unknown> = {}): FakeRedis {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(seed)) {
    store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const pendingReads: Array<[string, string]> = [];
  return {
    store,
    pendingReads,
    get: vi.fn(async (key: string) => {
      // Honour a one-shot override to model a value that was read before the
      // store moved on underneath us (the TOCTOU window).
      const idx = pendingReads.findIndex(([k]) => k === key);
      if (idx >= 0) {
        const [, value] = pendingReads.splice(idx, 1)[0];
        return value;
      }
      return store.get(key) ?? null;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }),
    // Minimal interpreter for the compare-and-delete script:
    // `if get(KEYS[1]) == ARGV[1] then del(KEYS[1]) else 0`.
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, arg: string) => {
      if (store.get(key) === arg) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };
}

function runningState(runId: string, conversationId: string): RunState {
  const state = createInitialRunState({ runId, userId: 'u', graphId: 'g', graphName: 'G', input: {}, conversationId });
  state.status = 'running';
  return state;
}

describe('getActiveRunForConversation — ownership-safe stale-pointer clearing', () => {
  it('returns the active run and leaves its pointer intact', async () => {
    const redis = makeRedis({
      [RunKeys.conversationRun('conv')]: 'run-live',
      [RunKeys.state('run-live')]: runningState('run-live', 'conv'),
    });
    expect(await getActiveRunForConversation(redis as never, 'conv')).toBe('run-live');
    expect(redis.store.get(RunKeys.conversationRun('conv'))).toBe('run-live');
  });

  it('returns null when there is no pointer', async () => {
    const redis = makeRedis();
    expect(await getActiveRunForConversation(redis as never, 'conv')).toBeNull();
  });

  it('clears a pointer that names a run with no state (still names that run)', async () => {
    const redis = makeRedis({ [RunKeys.conversationRun('conv')]: 'run-gone' }); // no state key
    expect(await getActiveRunForConversation(redis as never, 'conv')).toBeNull();
    expect(redis.store.has(RunKeys.conversationRun('conv'))).toBe(false);
  });

  it('clears a pointer that names an already-terminal run', async () => {
    const done = runningState('run-done', 'conv');
    done.status = 'completed';
    const redis = makeRedis({
      [RunKeys.conversationRun('conv')]: 'run-done',
      [RunKeys.state('run-done')]: done,
    });
    expect(await getActiveRunForConversation(redis as never, 'conv')).toBeNull();
    expect(redis.store.has(RunKeys.conversationRun('conv'))).toBe(false);
  });

  it('does NOT clobber a fresh acquirer that repointed the conversation in the read↔delete window', async () => {
    // The store already holds the FRESH run's live pointer + running state, but
    // the first pointer GET observes the STALE (now-dead) run's id — modelling a
    // superseding run that won the conversation between the read and the clear.
    const redis = makeRedis({
      [RunKeys.conversationRun('conv')]: 'run-fresh', // fresh acquirer owns it now
      [RunKeys.state('run-fresh')]: runningState('run-fresh', 'conv'),
      // 'run-stale' has NO state key → the helper decides its pointer is stale...
    });
    redis.pendingReads.push([RunKeys.conversationRun('conv'), 'run-stale']); // ...but reads the stale id

    const result = await getActiveRunForConversation(redis as never, 'conv');

    // It reports no *stale* active run (the id it read is dead)...
    expect(result).toBeNull();
    // ...but the compare-and-delete no-ops because the pointer now names run-fresh,
    // so the fresh acquirer's live pointer survives (blind DEL would have wiped it).
    expect(redis.store.get(RunKeys.conversationRun('conv'))).toBe('run-fresh');
  });
});
