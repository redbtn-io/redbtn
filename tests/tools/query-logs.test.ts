/**
 * Vitest for native tool: query_logs
 *
 * Per TOOL-HANDOFF.md §6.1 — schema + happy path + validation + upstream error.
 *
 * Talks to LogReader directly (not a fetch endpoint), so the upstream-error
 * case is exercised by injecting a LogReader mock that throws on `.query()`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import queryLogsTool, {
  __setLogReaderForTest,
  __getLogReaderForTest,
} from '../../src/lib/tools/native/query-logs';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1' },
    runId: 'run-test',
    nodeId: 'node-1',
    toolId: 'tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

interface CapturedQuery {
  scope?: Record<string, string>;
  level?: string;
  category?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

function makeFakeReader(opts: {
  throws?: Error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  results?: Array<Record<string, any>>;
} = {}): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (q: CapturedQuery) => Promise<Array<Record<string, any>>>;
  calls: CapturedQuery[];
} {
  const calls: CapturedQuery[] = [];
  return {
    calls,
    async query(q: CapturedQuery) {
      if (opts.throws) throw opts.throws;
      calls.push(q);
      return opts.results ?? [];
    },
  };
}

describe('query_logs — schema', () => {
  test('describes scope requirement; level enum matches LOG_LEVELS', () => {
    expect(queryLogsTool.description.toLowerCase()).toContain('log');
    expect(queryLogsTool.inputSchema.properties.runId).toBeDefined();
    expect(queryLogsTool.inputSchema.properties.conversationId).toBeDefined();
    expect(queryLogsTool.inputSchema.properties.level.enum).toEqual([
      'debug',
      'info',
      'success',
      'warn',
      'error',
      'fatal',
    ]);
    expect(queryLogsTool.inputSchema.properties.limit.maximum).toBe(1000);
  });

  test('anyOf enforces runId | conversationId at the schema level', () => {
    expect(queryLogsTool.inputSchema.anyOf).toEqual([
      { required: ['runId'] },
      { required: ['conversationId'] },
    ]);
  });

  test('server label is system', () => {
    expect(queryLogsTool.server).toBe('system');
  });
});

describe('query_logs — validation', () => {
  beforeEach(() => {
    __setLogReaderForTest(makeFakeReader());
  });

  afterEach(() => {
    __setLogReaderForTest(null);
  });

  test('missing both runId and conversationId returns isError + VALIDATION', async () => {
    const r = await queryLogsTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/runId/);
    expect(body.error).toMatch(/conversationId/);
  });

  test('blank runId + blank conversationId returns isError + VALIDATION', async () => {
    const r = await queryLogsTool.handler(
      { runId: '   ', conversationId: '\t\n' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('invalid level returns isError + VALIDATION', async () => {
    const r = await queryLogsTool.handler(
      { runId: 'r1', level: 'critical' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/level/);
  });
});

describe('query_logs — happy path', () => {
  let fake: ReturnType<typeof makeFakeReader>;

  beforeEach(() => {
    fake = makeFakeReader({
      results: [
        { id: '1', level: 'info', message: 'a', timestamp: 1 },
        { id: '2', level: 'warn', message: 'b', timestamp: 2 },
      ],
    });
    __setLogReaderForTest(fake);
  });

  afterEach(() => {
    __setLogReaderForTest(null);
    vi.restoreAllMocks();
  });

  test('runId-only query maps to scope.generationId, default limit 200, asc order', async () => {
    const r = await queryLogsTool.handler({ runId: 'run-abc' }, makeMockContext());
    expect(r.isError).toBeFalsy();

    const body = JSON.parse(r.content[0].text);
    expect(body.count).toBe(2);
    expect(body.limit).toBe(200);
    expect(body.scope.runId).toBe('run-abc');
    expect(body.scope.conversationId).toBeNull();
    expect(body.level).toBeNull();
    expect(body.category).toBeNull();
    expect(body.logs).toHaveLength(2);

    expect(fake.calls).toHaveLength(1);
    const q = fake.calls[0];
    expect(q.scope).toEqual({ generationId: 'run-abc' });
    expect(q.limit).toBe(200);
    expect(q.order).toBe('asc');
    expect(q.level).toBeUndefined();
    expect(q.category).toBeUndefined();
  });

  test('conversationId-only query maps to scope.conversationId', async () => {
    await queryLogsTool.handler(
      { conversationId: 'conv-xyz' },
      makeMockContext(),
    );
    expect(fake.calls[0].scope).toEqual({ conversationId: 'conv-xyz' });
  });

  test('both runId + conversationId merge into scope (AND filter)', async () => {
    await queryLogsTool.handler(
      { runId: 'r1', conversationId: 'c1' },
      makeMockContext(),
    );
    expect(fake.calls[0].scope).toEqual({
      generationId: 'r1',
      conversationId: 'c1',
    });
  });

  test('forwards level + category filters and reports them in body', async () => {
    const r = await queryLogsTool.handler(
      {
        runId: 'r',
        level: 'warn',
        category: 'tool',
      },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.level).toBe('warn');
    expect(body.category).toBe('tool');
    expect(fake.calls[0].level).toBe('warn');
    expect(fake.calls[0].category).toBe('tool');
  });

  test('lowercases mixed-case level', async () => {
    await queryLogsTool.handler(
      { runId: 'r', level: 'WARN' },
      makeMockContext(),
    );
    expect(fake.calls[0].level).toBe('warn');
  });

  test('limit caps at MAX_LIMIT (1000)', async () => {
    const r = await queryLogsTool.handler(
      { runId: 'r', limit: 999_999 },
      makeMockContext(),
    );
    expect(JSON.parse(r.content[0].text).limit).toBe(1000);
    expect(fake.calls[0].limit).toBe(1000);
  });

  test('limit floors fractional inputs and respects min 1', async () => {
    await queryLogsTool.handler(
      { runId: 'r', limit: 50.7 },
      makeMockContext(),
    );
    expect(fake.calls[0].limit).toBe(50);

    fake.calls.length = 0;
    await queryLogsTool.handler(
      { runId: 'r', limit: 0.5 },
      makeMockContext(),
    );
    // 0.5 is > 0 (passes the gate), floors to 0, then min-clamped to 1.
    expect(fake.calls[0].limit).toBe(1);

    fake.calls.length = 0;
    await queryLogsTool.handler(
      { runId: 'r', limit: 0 },
      makeMockContext(),
    );
    // 0 fails the `> 0` gate → falls back to DEFAULT_LIMIT 200.
    expect(fake.calls[0].limit).toBe(200);

    fake.calls.length = 0;
    await queryLogsTool.handler(
      { runId: 'r', limit: -10 },
      makeMockContext(),
    );
    // negative also fails the gate → default.
    expect(fake.calls[0].limit).toBe(200);
  });

  test('returns empty logs array when reader has no results', async () => {
    __setLogReaderForTest(makeFakeReader({ results: [] }));
    const r = await queryLogsTool.handler({ runId: 'r' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.count).toBe(0);
    expect(body.logs).toEqual([]);
  });

  test('handles reader returning non-array gracefully', async () => {
    __setLogReaderForTest({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: async () => null as any,
    });
    const r = await queryLogsTool.handler({ runId: 'r' }, makeMockContext());
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.logs).toEqual([]);
    expect(body.count).toBe(0);
  });

  test('test setter wired correctly', () => {
    expect(__getLogReaderForTest()).toBe(fake);
  });
});

describe('query_logs — upstream error', () => {
  beforeEach(() => {
    __setLogReaderForTest(makeFakeReader({ throws: new Error('mongo down') }));
  });

  afterEach(() => {
    __setLogReaderForTest(null);
  });

  test('reader .query() throw surfaces as isError without crashing', async () => {
    const r = await queryLogsTool.handler(
      { runId: 'r' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toMatch(/mongo down/);
    expect(body.scope).toEqual({ generationId: 'r' });
  });
});
