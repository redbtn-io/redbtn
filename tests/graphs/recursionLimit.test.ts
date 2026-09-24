import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateGraph, END, START } from '@langchain/langgraph';
import {
  DEFAULT_RECURSION_LIMIT,
  MAX_RECURSION_LIMIT,
  resolveRecursionLimit,
  isGraphRecursionError,
  formatRecursionLimitError,
} from '../../src/lib/graphs/recursionLimit';

describe('recursionLimit helper', () => {
  const originalEnv = process.env.ENGINE_DEFAULT_RECURSION_LIMIT;

  beforeEach(() => {
    delete process.env.ENGINE_DEFAULT_RECURSION_LIMIT;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ENGINE_DEFAULT_RECURSION_LIMIT = originalEnv;
    } else {
      delete process.env.ENGINE_DEFAULT_RECURSION_LIMIT;
    }
  });

  it('resolves default recursion limit when unconfigured', () => {
    expect(resolveRecursionLimit()).toBe(10_000);
    expect(resolveRecursionLimit(null)).toBe(10_000);
    expect(resolveRecursionLimit({})).toBe(10_000);
  });

  it('reads recursionLimit from graphConfig.config.recursionLimit', () => {
    expect(resolveRecursionLimit({ config: { recursionLimit: 500 } })).toBe(500);
  });

  it('reads recursionLimit from root graphConfig.recursionLimit', () => {
    expect(resolveRecursionLimit({ recursionLimit: 1200 })).toBe(1200);
  });

  it('prefers config.recursionLimit over root recursionLimit', () => {
    expect(resolveRecursionLimit({ recursionLimit: 1000, config: { recursionLimit: 2000 } })).toBe(2000);
  });

  it('reads recursionLimit from process.env.ENGINE_DEFAULT_RECURSION_LIMIT', () => {
    process.env.ENGINE_DEFAULT_RECURSION_LIMIT = '25000';
    expect(resolveRecursionLimit()).toBe(25_000);
  });

  it('caps recursion limit at MAX_RECURSION_LIMIT (100000)', () => {
    expect(resolveRecursionLimit({ config: { recursionLimit: 500_000 } })).toBe(100_000);
    process.env.ENGINE_DEFAULT_RECURSION_LIMIT = '999999';
    expect(resolveRecursionLimit()).toBe(100_000);
  });

  it('clamps invalid / non-positive numbers to at least 1 or falls back to default', () => {
    expect(resolveRecursionLimit({ config: { recursionLimit: 0 } })).toBe(10_000);
    expect(resolveRecursionLimit({ config: { recursionLimit: -10 } })).toBe(10_000);
  });

  it('detects GraphRecursionError and formats clear message', () => {
    const error = new Error('Recursion limit of 25 reached without hitting a stop condition. You can increase the limit by setting the "recursionLimit" config key.');
    error.name = 'GraphRecursionError';

    expect(isGraphRecursionError(error)).toBe(true);
    const formatted = formatRecursionLimitError(error, 25);
    expect(formatted).toBe(
      'Graph recursion limit of 25 reached without hitting a stop condition. You can raise it by setting graph.config.recursionLimit (up to 100000) or the ENGINE_DEFAULT_RECURSION_LIMIT environment variable.'
    );
  });

  it('runs a graph with a conditional back-edge for 100 cycles', async () => {
    // A LangGraph instance that cycles 100 times. LangGraph's default recursionLimit is 25,
    // so this would fail without the configured recursion limit.
    const graph = new StateGraph<any>({
      channels: {
        cycle: {
          value: (x, y) => (y !== undefined ? y : x),
          default: () => 0,
        },
      },
    })
      .addNode('increment', (state: any) => ({ cycle: (state.cycle || 0) + 1 }))
      .addEdge(START, 'increment')
      .addConditionalEdges('increment', (state: any) => {
        return state.cycle < 100 ? 'increment' : END;
      })
      .compile();

    const limit = resolveRecursionLimit({ config: { recursionLimit: 200 } });
    expect(limit).toBe(200);

    const result = await graph.invoke({ cycle: 0 }, { recursionLimit: limit });
    expect(result.cycle).toBe(100);
  });

  it('hits recursion limit when cycles exceed configured limit and formats error', async () => {
    const graph = new StateGraph<any>({
      channels: {
        cycle: {
          value: (x, y) => (y !== undefined ? y : x),
          default: () => 0,
        },
      },
    })
      .addNode('increment', (state: any) => ({ cycle: (state.cycle || 0) + 1 }))
      .addEdge(START, 'increment')
      .addConditionalEdges('increment', (state: any) => {
        return state.cycle < 100 ? 'increment' : END;
      })
      .compile();

    // Set limit to 20 cycles; loop needs 100 cycles to terminate.
    const limit = resolveRecursionLimit({ config: { recursionLimit: 20 } });
    expect(limit).toBe(20);

    try {
      await graph.invoke({ cycle: 0 }, { recursionLimit: limit });
      expect.fail('Should have thrown recursion error');
    } catch (err) {
      expect(isGraphRecursionError(err)).toBe(true);
      const msg = formatRecursionLimitError(err, limit);
      expect(msg).toContain('Graph recursion limit of 20 reached without hitting a stop condition.');
      expect(msg).toContain('setting graph.config.recursionLimit (up to 100000)');
    }
  });
});
