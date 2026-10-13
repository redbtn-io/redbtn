/**
 * Run-length limits (engine 0.0.301): unlimited option, raised defaults and
 * the runaway guard, for API and CLI neurons.
 *
 * Trigger: a Become Ops CLI run stopped mid-job at 208 tool calls (old CLI
 * default 50 turns -> 50*4+8 bridge calls).
 */
import { describe, it, expect } from 'vitest';
import {
  parseLimit,
  resolveToolIterationLimit,
  bridgeCallBudget,
  resolveStepTimeoutMs,
  resolveMaxRepeatedToolCalls,
  RepeatedCallGuard,
  DEFAULT_CLI_MAX_TURNS,
  DEFAULT_API_MAX_TOOL_ITERATIONS,
  DEFAULT_CLI_STEP_TIMEOUT_MS,
  UNLIMITED_TIMEOUT_MS,
  MAX_CALLS_CEILING,
} from '../../src/lib/neurons/run-limits';
import { buildSpawnArgs, DEFAULT_MAX_TURNS, DEFAULT_TIMEOUT_MS } from '../../src/lib/nodes/universal/executors/claudeCodeExecutor';
import { runNativeToolUseLoop } from '../../src/lib/nodes/universal/executors/neuronExecutor';
import type { ResolvedTool } from '../../src/lib/tools/tool-resolver';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('parseLimit / resolvers', () => {
  it('0, -1, Infinity and "unlimited"/"none" mean unlimited; unset means default', () => {
    for (const v of [0, -1, Infinity, 'unlimited', 'NONE', ' Unlimited ', '0']) expect(parseLimit(v), String(v)).toBeNull();
    for (const v of [undefined, null, '', 'abc', NaN, -5, {}]) expect(parseLimit(v), String(v)).toBeUndefined();
    expect(parseLimit(12)).toBe(12);
    expect(parseLimit('300')).toBe(300);
    expect(parseLimit(7.9)).toBe(7);
  });

  it('defaults: 500 CLI turns (~2,000 bridge calls), 25 API iterations, 12 h CLI steps', () => {
    expect(DEFAULT_CLI_MAX_TURNS).toBe(500);
    expect(DEFAULT_MAX_TURNS).toBe(500);
    expect(DEFAULT_API_MAX_TOOL_ITERATIONS).toBe(25);
    expect(DEFAULT_CLI_STEP_TIMEOUT_MS).toBe(12 * 3600_000);
    expect(DEFAULT_TIMEOUT_MS).toBe(12 * 3600_000);
    expect(bridgeCallBudget(undefined)).toBe(2008);
    expect(resolveToolIterationLimit(undefined, DEFAULT_API_MAX_TOOL_ITERATIONS)).toBe(25);
  });

  it('bridge budget: explicit numbers keep n*4+8 under the ceiling; unlimited is Infinity', () => {
    expect(bridgeCallBudget(12)).toBe(56);
    expect(bridgeCallBudget(10_000_000)).toBe(MAX_CALLS_CEILING);
    expect(bridgeCallBudget(0)).toBe(Infinity);
    expect(bridgeCallBudget('unlimited')).toBe(Infinity);
  });

  it('step timeout: unlimited is the largest safe timer, numbers pass through', () => {
    expect(resolveStepTimeoutMs(0, 1000)).toBe(UNLIMITED_TIMEOUT_MS);
    expect(resolveStepTimeoutMs('unlimited', 1000)).toBe(UNLIMITED_TIMEOUT_MS);
    expect(resolveStepTimeoutMs(undefined, 1000)).toBe(1000);
    expect(resolveStepTimeoutMs(8 * 3600_000, 1000)).toBe(8 * 3600_000);
    expect(resolveStepTimeoutMs(Number.MAX_SAFE_INTEGER, 1000)).toBe(UNLIMITED_TIMEOUT_MS);
  });

  it('runaway guard threshold defaults to 50, 0 turns it off', () => {
    expect(resolveMaxRepeatedToolCalls(undefined)).toBe(50);
    expect(resolveMaxRepeatedToolCalls(0)).toBeNull();
    expect(resolveMaxRepeatedToolCalls(5)).toBe(5);
  });
});

describe('RepeatedCallGuard', () => {
  it('trips only on identical call + identical result streaks', () => {
    const g = new RepeatedCallGuard(3);
    for (let i = 0; i < 3; i++) {
      expect(g.shouldRefuse('t', { a: 1, b: 2 })).toBe(false);
      g.record('t', { b: 2, a: 1 }, { ok: true }); // key order does not matter
    }
    expect(g.shouldRefuse('t', { a: 1, b: 2 })).toBe(true);
    expect(g.shouldRefuse('t', { a: 2 })).toBe(false);
    expect(g.message('t')).toMatch(/runaway guard/);
  });

  it('a poll whose result changes never trips it', () => {
    const g = new RepeatedCallGuard(3);
    for (let i = 0; i < 20; i++) {
      expect(g.shouldRefuse('get_status', { id: 'x' })).toBe(false);
      g.record('get_status', { id: 'x' }, { status: 'working', at: i });
    }
  });

  it('a null limit never refuses', () => {
    const g = new RepeatedCallGuard(null);
    for (let i = 0; i < 100; i++) g.record('t', {}, 1);
    expect(g.shouldRefuse('t', {})).toBe(false);
  });
});

describe('claude-code --max-turns', () => {
  const base = { model: 'claude-opus-5', mcpConfigPath: '/tmp/x/mcp.json' };
  it('passes --max-turns for a number and omits it when unlimited', () => {
    expect(buildSpawnArgs({ ...base, maxTurns: 500 })).toEqual(expect.arrayContaining(['--max-turns', '500']));
    expect(buildSpawnArgs({ ...base, maxTurns: null })).not.toContain('--max-turns');
  });
});

describe('API tool loop', () => {
  function harness(maxToolIterations: unknown, opts: { result?: (i: number) => unknown; maxRepeatedToolCalls?: unknown; stopAfter?: number } = {}) {
    let invocations = 0;
    let modelCalls = 0;
    const resolvedTools: ResolvedTool[] = [
      {
        name: 'poll',
        description: 'poll',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        source: 'native',
        invoke: async () => {
          invocations += 1;
          return opts.result ? opts.result(invocations) : { status: 'same' };
        },
      },
    ];
    const neuronRegistry = {
      callNeuron: async () => {
        modelCalls += 1;
        if (opts.stopAfter && modelCalls > opts.stopAfter) return { content: 'done', tool_calls: [] };
        return { content: '', tool_calls: [{ id: `c${modelCalls}`, name: 'poll', args: { id: 'x' } }] };
      },
    };
    const state: Any = { runPublisher: { chunk: async () => {}, toolStart: async () => {}, toolComplete: async () => {}, toolError: async () => {} }, data: {} };
    const run = () =>
      runNativeToolUseLoop({
        config: { userPrompt: 'go', outputField: 'result', maxToolIterations, maxRepeatedToolCalls: opts.maxRepeatedToolCalls } as Any,
        state,
        model: { bindTools: () => ({}) },
        baseMessages: [{ role: 'user', content: 'hi' }],
        resolvedTools,
        neuronId: 'n',
        userId: 'u',
        callRunId: undefined,
        abortSignal: undefined,
        neuronRegistry,
      } as Any);
    return { run, invocations: () => invocations, modelCalls: () => modelCalls };
  }

  it('defaults to 25 iterations (was 5)', async () => {
    const h = harness(undefined, { result: (i) => ({ status: 'working', i }) });
    await h.run();
    expect(h.invocations()).toBe(25);
  });

  it('maxToolIterations 0 = unlimited: a long honest loop (changing results) is not capped', async () => {
    const h = harness(0, { result: (i) => ({ status: 'working', i }), stopAfter: 120 });
    await h.run();
    expect(h.invocations()).toBe(120);
  });

  it('unlimited + runaway guard: identical call/result streak is refused, then the loop ends', async () => {
    const h = harness('unlimited', { maxRepeatedToolCalls: 4 });
    await h.run();
    // 4 executed, then 3 consecutive refusals end the loop
    expect(h.invocations()).toBe(4);
    expect(h.modelCalls()).toBe(7);
  });
});
