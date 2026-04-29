/**
 * Vitest for native tool: write_log
 *
 * Per TOOL-HANDOFF.md §6.1 — schema + happy path + validation + upstream error.
 *
 * The tool talks to RedLog (NOT a fetch endpoint) so the upstream-error case
 * is exercised by injecting a RedLog mock that throws on `.log()`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import writeLogTool, {
  __setRedLogForTest,
  __getRedLogForTest,
} from '../../src/lib/tools/native/write-log';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1', conversationId: 'conv-1' },
    runId: 'run-1',
    nodeId: 'node-1',
    toolId: 'tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

interface CapturedCall {
  level: string;
  message: string;
  category?: string;
  scope?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

function makeFakeRedLog(opts: { throws?: Error } = {}): {
  log: (p: CapturedCall) => Promise<void>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  return {
    calls,
    async log(params: CapturedCall) {
      if (opts.throws) throw opts.throws;
      calls.push(params);
    },
  };
}

describe('write_log — schema', () => {
  test('requires level + message; level enum matches LOG_LEVELS', () => {
    expect(writeLogTool.description.toLowerCase()).toContain('log');
    expect(writeLogTool.inputSchema.required).toEqual(['level', 'message']);
    expect(writeLogTool.inputSchema.properties.level.enum).toEqual([
      'debug',
      'info',
      'success',
      'warn',
      'error',
      'fatal',
    ]);
    expect(writeLogTool.inputSchema.properties.message).toBeDefined();
    expect(writeLogTool.inputSchema.properties.category).toBeDefined();
    expect(writeLogTool.inputSchema.properties.metadata).toBeDefined();
  });

  test('server label is system', () => {
    expect(writeLogTool.server).toBe('system');
  });
});

describe('write_log — validation', () => {
  beforeEach(() => {
    // Inject a fake so validation paths don't accidentally try to talk to Redis.
    __setRedLogForTest(makeFakeRedLog());
  });

  afterEach(() => {
    __setRedLogForTest(null);
  });

  test('missing level returns isError + VALIDATION', async () => {
    const r = await writeLogTool.handler({ message: 'hi' }, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/level/);
  });

  test('invalid level returns isError + VALIDATION', async () => {
    const r = await writeLogTool.handler(
      { level: 'critical', message: 'hi' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/level/);
  });

  test('missing message returns isError + VALIDATION', async () => {
    const r = await writeLogTool.handler({ level: 'info' }, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/message/);
  });

  test('whitespace-only message returns isError + VALIDATION', async () => {
    const r = await writeLogTool.handler(
      { level: 'info', message: '   \n\t' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('write_log — happy path', () => {
  let fake: ReturnType<typeof makeFakeRedLog>;

  beforeEach(() => {
    fake = makeFakeRedLog();
    __setRedLogForTest(fake);
  });

  afterEach(() => {
    __setRedLogForTest(null);
    vi.restoreAllMocks();
  });

  test('writes a basic info entry with auto-derived scope', async () => {
    const r = await writeLogTool.handler(
      { level: 'info', message: 'hello world' },
      makeMockContext(),
    );

    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.level).toBe('info');
    expect(body.scope.runId).toBe('run-1');
    expect(body.scope.conversationId).toBe('conv-1');
    expect(body.truncated).toBe(false);

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.level).toBe('info');
    expect(call.message).toBe('hello world');
    // Scope mirrors RunPublisher: runId → generationId
    expect(call.scope?.generationId).toBe('run-1');
    expect(call.scope?.conversationId).toBe('conv-1');
    expect(call.scope?.userId).toBe('user-1');
    expect(call.scope?.nodeId).toBe('node-1');
    // Metadata enrichment
    expect(call.metadata?.source).toBe('write_log');
    expect(call.metadata?.runId).toBe('run-1');
    expect(call.metadata?.nodeId).toBe('node-1');
  });

  test('forwards category and merges user metadata', async () => {
    await writeLogTool.handler(
      {
        level: 'warn',
        message: 'careful',
        category: 'milestone',
        metadata: { phase: 'planning', attempt: 3 },
      },
      makeMockContext(),
    );

    const call = fake.calls[0];
    expect(call.category).toBe('milestone');
    expect(call.metadata?.phase).toBe('planning');
    expect(call.metadata?.attempt).toBe(3);
    // Auto fields still merged.
    expect(call.metadata?.source).toBe('write_log');
  });

  test('lowercases mixed-case levels', async () => {
    await writeLogTool.handler(
      { level: 'INFO', message: 'shouted' },
      makeMockContext(),
    );
    expect(fake.calls[0].level).toBe('info');
  });

  test('accepts every supported severity (debug/info/success/warn/error/fatal)', async () => {
    for (const level of ['debug', 'info', 'success', 'warn', 'error', 'fatal']) {
      const r = await writeLogTool.handler(
        { level, message: `hi from ${level}` },
        makeMockContext(),
      );
      expect(r.isError).toBeFalsy();
    }
    expect(fake.calls.map((c) => c.level)).toEqual([
      'debug',
      'info',
      'success',
      'warn',
      'error',
      'fatal',
    ]);
  });

  test('truncates very long messages and reports truncated:true', async () => {
    const long = 'x'.repeat(10_000);
    const r = await writeLogTool.handler(
      { level: 'info', message: long },
      makeMockContext(),
    );

    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.truncated).toBe(true);
    expect(body.messageLength).toBeLessThanOrEqual(8192);
    expect(fake.calls[0].message.length).toBe(body.messageLength);
  });

  test('omits scope.conversationId when not on context', async () => {
    await writeLogTool.handler(
      { level: 'info', message: 'no conv' },
      makeMockContext({ state: { userId: 'u1' }, runId: 'r2', nodeId: null }),
    );
    const call = fake.calls[0];
    expect(call.scope?.conversationId).toBeUndefined();
    expect(call.scope?.generationId).toBe('r2');
    expect(call.scope?.userId).toBe('u1');
  });

  test('omits scope entirely when no IDs are bound on the context', async () => {
    // Scope ends up as an empty object → should be passed as undefined so
    // redlog doesn't index this entry under any list.
    await writeLogTool.handler(
      { level: 'info', message: 'orphan' },
      makeMockContext({ state: {}, runId: null, nodeId: null }),
    );
    const call = fake.calls[0];
    expect(call.scope).toBeUndefined();
  });

  test('rejects non-object metadata silently (no merge of non-objects)', async () => {
    // Per the schema, metadata is optional + must be object. The handler
    // tolerates malformed input rather than throwing — non-objects are
    // dropped and the auto-enriched fields still land.
    await writeLogTool.handler(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { level: 'info', message: 'm', metadata: 'not-an-object' as any },
      makeMockContext(),
    );
    const call = fake.calls[0];
    // Source is still added; nothing else from the bad input.
    expect(call.metadata?.source).toBe('write_log');
    expect(call.metadata?.['not-an-object']).toBeUndefined();
  });

  test('readers see the entry in the same redlog instance', () => {
    // Sanity: the test setter actually replaced the singleton.
    expect(__getRedLogForTest()).toBe(fake);
  });
});

describe('write_log — upstream error', () => {
  beforeEach(() => {
    __setRedLogForTest(makeFakeRedLog({ throws: new Error('redis down') }));
  });

  afterEach(() => {
    __setRedLogForTest(null);
  });

  test('redlog .log() throw surfaces as isError without crashing', async () => {
    const r = await writeLogTool.handler(
      { level: 'info', message: 'will fail' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toMatch(/redis down/);
  });
});
