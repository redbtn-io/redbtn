import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateGraph, END, START } from '@langchain/langgraph';
import {
  DEFAULT_RECURSION_LIMIT,
  MAX_RECURSION_LIMIT,
  resolveRecursionLimit,
  isGraphRecursionError,
  formatRecursionLimitError,
} from '../../src/lib/graphs/recursionLimit';
import { Graph } from '../../src/lib/models/Graph';
import {
  getRunConfigTimeoutMs,
  DEFAULT_MAX_RUN_TIMEOUT_S,
  DEFAULT_RUN_TIMEOUT_S,
  getMaxRunTimeoutSeconds,
  getDefaultRunTimeoutSeconds,
  RunConfigTimeoutError,
} from '../../src/functions/run';

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

  describe('Graph Mongoose model schema persistence & validation', () => {
    it('preserves recursionLimit and explicit timeout on doc.toObject()', () => {
      const doc = new Graph({
        graphId: 'test-persistence',
        userId: 'u1',
        name: 'Test Persistence',
        nodes: [{ id: 'n1', type: 'universal' }],
        edges: [{ from: '__start__', to: 'n1' }],
        config: { recursionLimit: 50, timeout: 60 },
      });

      const plain = doc.toObject();
      expect(plain.config?.recursionLimit).toBe(50);
      expect(plain.config?.timeout).toBe(60);
      expect(resolveRecursionLimit(plain)).toBe(50);
    });

    it('does NOT default timeout to 300 when config is unconfigured', () => {
      const doc = new Graph({
        graphId: 'test-no-timeout',
        userId: 'u1',
        name: 'Test No Timeout',
        nodes: [{ id: 'n1', type: 'universal' }],
        edges: [{ from: '__start__', to: 'n1' }],
        config: {},
      });

      const plain = doc.toObject();
      expect(plain.config?.timeout).toBeUndefined();
    });

    it('validates recursionLimit bounds (1 to 100000)', async () => {
      const docTooLow = new Graph({
        graphId: 'test-low',
        userId: 'u1',
        name: 'Test Low',
        nodes: [{ id: 'n1', type: 'universal' }],
        edges: [{ from: '__start__', to: 'n1' }],
        config: { recursionLimit: 0 },
      });
      const errLow = docTooLow.validateSync();
      expect(errLow?.errors['config.recursionLimit']).toBeDefined();

      const docTooHigh = new Graph({
        graphId: 'test-high',
        userId: 'u1',
        name: 'Test High',
        nodes: [{ id: 'n1', type: 'universal' }],
        edges: [{ from: '__start__', to: 'n1' }],
        config: { recursionLimit: 100001 },
      });
      const errHigh = docTooHigh.validateSync();
      expect(errHigh?.errors['config.recursionLimit']).toBeDefined();

      const docValid = new Graph({
        graphId: 'test-valid',
        userId: 'u1',
        name: 'Test Valid',
        nodes: [{ id: 'n1', type: 'universal' }],
        edges: [{ from: '__start__', to: 'n1' }],
        config: { recursionLimit: 100000 },
      });
      expect(docValid.validateSync()).toBeUndefined();
    });
  });

  describe('getRunConfigTimeoutMs helper', () => {
    const originalMaxEnv = process.env.ENGINE_MAX_RUN_TIMEOUT_S;
    const originalDefaultEnv = process.env.ENGINE_DEFAULT_RUN_TIMEOUT_S;
    const originalConfigEnv = process.env.RUN_CONFIG_TIMEOUT_MS;

    beforeEach(() => {
      delete process.env.ENGINE_MAX_RUN_TIMEOUT_S;
      delete process.env.ENGINE_DEFAULT_RUN_TIMEOUT_S;
      delete process.env.RUN_CONFIG_TIMEOUT_MS;
    });

    afterEach(() => {
      if (originalMaxEnv !== undefined) {
        process.env.ENGINE_MAX_RUN_TIMEOUT_S = originalMaxEnv;
      } else {
        delete process.env.ENGINE_MAX_RUN_TIMEOUT_S;
      }
      if (originalDefaultEnv !== undefined) {
        process.env.ENGINE_DEFAULT_RUN_TIMEOUT_S = originalDefaultEnv;
      } else {
        delete process.env.ENGINE_DEFAULT_RUN_TIMEOUT_S;
      }
      if (originalConfigEnv !== undefined) {
        process.env.RUN_CONFIG_TIMEOUT_MS = originalConfigEnv;
      } else {
        delete process.env.RUN_CONFIG_TIMEOUT_MS;
      }
    });

    it('verifies platform defaults: 12h default (43200s) and 24h ceiling (86400s)', () => {
      expect(DEFAULT_RUN_TIMEOUT_S).toBe(43200);
      expect(DEFAULT_MAX_RUN_TIMEOUT_S).toBe(86400);
      expect(getDefaultRunTimeoutSeconds()).toBe(43200);
      expect(getMaxRunTimeoutSeconds()).toBe(86400);
    });

    // Case 1: Unset timeout
    it('Case 1: resolves default 12h (43200000ms) when graph timeout is unset', () => {
      expect(getRunConfigTimeoutMs({})).toBe(43_200_000);
      expect(getRunConfigTimeoutMs({ config: {} })).toBe(43_200_000);
      expect(getRunConfigTimeoutMs({ config: { config: {} } })).toBe(43_200_000);
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: undefined } } })).toBe(43_200_000);
    });

    it('Case 1: honors ENGINE_DEFAULT_RUN_TIMEOUT_S env override for unset timeout', () => {
      process.env.ENGINE_DEFAULT_RUN_TIMEOUT_S = '3600'; // 1 hour
      expect(getRunConfigTimeoutMs({})).toBe(3_600_000);
      expect(getRunConfigTimeoutMs({ config: {} })).toBe(3_600_000);
    });

    // Case 2: Explicit 0
    it('Case 2: resolves platform ceiling (86400000ms / 24h) when timeout is explicitly 0 (treated as "no graph limit")', () => {
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: 0 } } })).toBe(86_400_000);
      expect(getRunConfigTimeoutMs({ config: { timeout: 0 } })).toBe(86_400_000);
      // Explicit 0 is never 0: there is NEVER a truly unbounded run
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: 0 } } })).toBeGreaterThan(0);
    });

    // Case 3: Explicit positive
    it('Case 3: honours explicit positive seconds converted to ms', () => {
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: 5 } } })).toBe(5_000);
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: 60 } } })).toBe(60_000);
      expect(getRunConfigTimeoutMs({ config: { timeout: 120 } })).toBe(120_000);
    });

    it('Case 3: honours ops graphs with timeout: 86400 (24h) unchanged', () => {
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: 86400 } } })).toBe(86_400_000);
      expect(getRunConfigTimeoutMs({ config: { timeout: 86400 } })).toBe(86_400_000);
    });

    it('Case 3: caps explicit positive timeouts exceeding the platform ceiling (86400s / 24h)', () => {
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: 100000 } } })).toBe(86_400_000);
    });

    // Case 4: RUN_CONFIG_TIMEOUT_MS precedence
    it('Case 4: honors RUN_CONFIG_TIMEOUT_MS when graph timeout is unset, capped at ceiling', () => {
      process.env.RUN_CONFIG_TIMEOUT_MS = '300000'; // 5 min
      expect(getRunConfigTimeoutMs({})).toBe(300_000);
      expect(getRunConfigTimeoutMs({ config: {} })).toBe(300_000);

      // Above ceiling gets capped
      process.env.RUN_CONFIG_TIMEOUT_MS = '100000000';
      expect(getRunConfigTimeoutMs({})).toBe(86_400_000);
    });

    it('Case 4: graph explicit timeout takes precedence over RUN_CONFIG_TIMEOUT_MS', () => {
      process.env.RUN_CONFIG_TIMEOUT_MS = '300000';
      // Explicit positive overrides env
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: 10 } } })).toBe(10_000);
      // Explicit 0 overrides env and receives platform ceiling
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: 0 } } })).toBe(86_400_000);
    });

    // Ceiling: ENGINE_MAX_RUN_TIMEOUT_S override
    it('honors ENGINE_MAX_RUN_TIMEOUT_S env override ceiling across all cases', () => {
      process.env.ENGINE_MAX_RUN_TIMEOUT_S = '1800'; // 30 min ceiling (1,800,000 ms)

      // Unset timeout (default 43200s) capped at 1800s
      expect(getRunConfigTimeoutMs({})).toBe(1_800_000);

      // Explicit 0 capped at 1800s
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: 0 } } })).toBe(1_800_000);

      // Explicit positive above ceiling capped at 1800s
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: 3600 } } })).toBe(1_800_000);

      // Explicit positive below ceiling honored as-is
      expect(getRunConfigTimeoutMs({ config: { config: { timeout: 900 } } })).toBe(900_000);

      // RUN_CONFIG_TIMEOUT_MS above ceiling capped at 1800s
      process.env.RUN_CONFIG_TIMEOUT_MS = '5000000';
      expect(getRunConfigTimeoutMs({})).toBe(1_800_000);
    });

    it('verifies RunConfigTimeoutError error message format and guidance', () => {
      const err = new RunConfigTimeoutError('run-proof-123', 5000);
      expect(err.name).toBe('RunConfigTimeoutError');
      expect(err.code).toBe('RUN_CONFIG_TIMEOUT');
      expect(err.message).toContain('Run run-proof-123 exceeded configured timeout of 5000ms');
      expect(err.message).toContain('ENGINE_MAX_RUN_TIMEOUT_S');
      expect(err.message).toContain('ENGINE_DEFAULT_RUN_TIMEOUT_S');
    });
  });
});

