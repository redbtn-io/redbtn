/**
 * Integration test for the native logs pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a
 * small graph using the new tools end-to-end."
 *
 * The two new tools form a coherent write-then-read agent loop:
 *
 *    write_log    — append a structured entry into the shared redlog store
 *    query_logs   — read entries back, filtered by runId/conversationId
 *
 * We can't talk to a real Redis/Mongo here (the unit suite must be
 * hermetic), so we install an in-memory fake store and inject it into
 * both tools' singletons. Then we drive a realistic agent flow:
 *
 *    1. Agent writes 3 entries (debug + info + warn) for a run.
 *    2. Agent queries by runId — gets all 3 back.
 *    3. Agent queries with level:warn — gets only the warn back.
 *    4. Agent queries by conversationId — gets entries auto-scoped from
 *       step 1 (proves the auto-scope wiring matches the LogReader scope).
 *
 * This is the same test contract as the runs / streams packs.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';

// Re-import each tool by path. Under vitest the .js sibling file the
// registry's require() expects doesn't exist next to the .ts module, so
// the singleton's catch block silently swallows the load failure. We
// import the TS modules and explicitly re-register them, mirroring the
// pattern used by tests/integration/tools-runs.test.ts.
import writeLogTool, {
  __setRedLogForTest,
} from '../../src/lib/tools/native/write-log';
import queryLogsTool, {
  __setLogReaderForTest,
} from '../../src/lib/tools/native/query-logs';

// ---------------------------------------------------------------------------
// Shared in-memory fake "redlog backend" — the write-side and read-side both
// touch the same `store` so writes are visible to reads.
// ---------------------------------------------------------------------------

interface FakeEntry {
  id: string;
  level: string;
  message: string;
  category?: string;
  scope?: Record<string, string>;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

interface QueryShape {
  scope?: Record<string, string>;
  level?: string;
  category?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

const LEVEL_RANK: Record<string, number> = {
  debug: 0,
  info: 1,
  success: 2,
  warn: 3,
  warning: 3,
  error: 4,
  fatal: 5,
};

class FakeStore {
  entries: FakeEntry[] = [];
  private _counter = 0;

  reset(): void {
    this.entries = [];
    this._counter = 0;
  }

  // Mimics RedLog.log()
  async log(p: {
    level: string;
    message: string;
    category?: string;
    scope?: Record<string, string>;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    this._counter += 1;
    this.entries.push({
      id: `log_${this._counter}`,
      level: p.level,
      message: p.message,
      category: p.category,
      scope: p.scope,
      metadata: p.metadata,
      timestamp: Date.now() + this._counter, // monotonically increasing
    });
  }

  // Mimics LogReader.query() — applies scope (AND), level (>=), category, limit.
  async query(q: QueryShape): Promise<FakeEntry[]> {
    let out = [...this.entries];

    if (q.scope) {
      for (const [k, v] of Object.entries(q.scope)) {
        out = out.filter((e) => e.scope?.[k] === v);
      }
    }

    if (q.level) {
      const minRank = LEVEL_RANK[q.level] ?? 0;
      out = out.filter((e) => (LEVEL_RANK[e.level] ?? 0) >= minRank);
    }

    if (q.category) {
      out = out.filter((e) => e.category === q.category);
    }

    out.sort((a, b) =>
      q.order === 'desc' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp,
    );

    if (q.limit && q.limit > 0) out = out.slice(0, q.limit);
    return out;
  }
}

const fakeStore = new FakeStore();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {
      userId: 'agent-int',
      conversationId: 'conv-logs-int',
    },
    runId: 'run-logs-int',
    nodeId: 'node-int',
    toolId: 'tool-int-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('logs pack integration — registration + chained execution', () => {
  beforeAll(() => {
    const registry = getNativeRegistry();
    if (!registry.has('write_log')) registry.register('write_log', writeLogTool);
    if (!registry.has('query_logs')) registry.register('query_logs', queryLogsTool);
  });

  beforeEach(() => {
    fakeStore.reset();
    __setRedLogForTest(fakeStore);
    __setLogReaderForTest(fakeStore);
  });

  afterEach(() => {
    __setRedLogForTest(null);
    __setLogReaderForTest(null);
  });

  test('NativeToolRegistry has both new logs-pack tools registered as system', () => {
    const registry = getNativeRegistry();
    for (const name of ['write_log', 'query_logs']) {
      expect(registry.has(name)).toBe(true);
      expect(registry.get(name)?.server).toBe('system');
    }
  });

  test('end-to-end: agent writes 3 entries → queries by runId → filters by level → queries by conversationId', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    // ── 1. write three entries with different levels and one shared category ─
    for (const [level, message] of [
      ['debug', 'starting plan'],
      ['info', 'plan compiled'],
      ['warn', 'tool retry attempt 2'],
    ] as const) {
      const r = await registry.callTool(
        'write_log',
        { level, message, category: 'planner' },
        ctx,
      );
      expect(r.isError).toBeFalsy();
      const body = JSON.parse(r.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.scope.runId).toBe('run-logs-int');
      expect(body.scope.conversationId).toBe('conv-logs-int');
    }

    expect(fakeStore.entries).toHaveLength(3);
    // Auto-scope from context: runId → generationId, conversationId mirrored
    expect(fakeStore.entries[0].scope?.generationId).toBe('run-logs-int');
    expect(fakeStore.entries[0].scope?.conversationId).toBe('conv-logs-int');

    // ── 2. query by runId — expect all three ─────────────────────────────────
    const all = await registry.callTool(
      'query_logs',
      { runId: 'run-logs-int' },
      ctx,
    );
    expect(all.isError).toBeFalsy();
    const allBody = JSON.parse(all.content[0].text);
    expect(allBody.count).toBe(3);
    expect(allBody.logs.map((l: { level: string }) => l.level)).toEqual([
      'debug',
      'info',
      'warn',
    ]);

    // ── 3. filter by level=warn — only the warn entry ────────────────────────
    const warn = await registry.callTool(
      'query_logs',
      { runId: 'run-logs-int', level: 'warn' },
      ctx,
    );
    const warnBody = JSON.parse(warn.content[0].text);
    expect(warnBody.count).toBe(1);
    expect(warnBody.logs[0].level).toBe('warn');
    expect(warnBody.logs[0].message).toBe('tool retry attempt 2');

    // ── 4. query by conversationId — proves write-side scope.conversationId
    //       lines up with read-side scope.conversationId end-to-end ───────────
    const byConv = await registry.callTool(
      'query_logs',
      { conversationId: 'conv-logs-int' },
      ctx,
    );
    const convBody = JSON.parse(byConv.content[0].text);
    expect(convBody.count).toBe(3);
    expect(convBody.scope.conversationId).toBe('conv-logs-int');

    // ── 5. category filter narrows further ───────────────────────────────────
    const byCat = await registry.callTool(
      'query_logs',
      { conversationId: 'conv-logs-int', category: 'planner' },
      ctx,
    );
    expect(JSON.parse(byCat.content[0].text).count).toBe(3);

    const wrongCat = await registry.callTool(
      'query_logs',
      { conversationId: 'conv-logs-int', category: 'nonexistent' },
      ctx,
    );
    expect(JSON.parse(wrongCat.content[0].text).count).toBe(0);
  });

  test('write_log without context IDs writes a scope-less entry; query_logs cannot find it by scope', async () => {
    const registry = getNativeRegistry();
    const orphanCtx = makeMockContext({
      state: {},
      runId: null,
      nodeId: null,
    });

    // No scope binds the entry
    const w = await registry.callTool(
      'write_log',
      { level: 'info', message: 'orphaned breadcrumb' },
      orphanCtx,
    );
    expect(w.isError).toBeFalsy();
    expect(fakeStore.entries).toHaveLength(1);
    expect(fakeStore.entries[0].scope).toBeUndefined();

    // Querying by some unrelated runId returns nothing — confirms the
    // entry was correctly written without a scope (so no scope filter
    // matches it).
    const q = await registry.callTool(
      'query_logs',
      { runId: 'some-other-run' },
      makeMockContext(),
    );
    expect(JSON.parse(q.content[0].text).count).toBe(0);
  });

  test('query_logs without runId or conversationId is rejected (bounded scopes only)', async () => {
    const registry = getNativeRegistry();
    const r = await registry.callTool('query_logs', {}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('write_log lifts auto-metadata source=write_log for downstream filtering', async () => {
    const registry = getNativeRegistry();
    await registry.callTool(
      'write_log',
      { level: 'info', message: 'tagged', metadata: { foo: 'bar' } },
      makeMockContext(),
    );
    expect(fakeStore.entries[0].metadata?.source).toBe('write_log');
    expect(fakeStore.entries[0].metadata?.foo).toBe('bar');
    expect(fakeStore.entries[0].metadata?.runId).toBe('run-logs-int');
  });
});
