/**
 * Unit tests for validateGraphConfig — the engine-side dry-run validator.
 *
 * Covers every error rule + warning rule + edge cases enumerated in
 * PLATFORM-PACK-HANDOFF.md §2 Phase C.
 *
 * Notable design checks:
 *   - validator NEVER throws — collects ALL errors instead of failing fast
 *   - validator runs without mongoose / network — all checks are pure
 *   - optional registries (neuronCheck / nodeCheck / toolCheck) elevate or
 *     downgrade specific checks correctly (tool warnings vs neuron errors)
 */

import { describe, test, expect } from 'vitest';
import {
  validateGraphConfig,
  type ValidationResult,
} from '../../src/lib/graphs/validateGraphConfig';
import type { GraphConfig } from '../../src/lib/types/graph';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseConfig(over: Partial<GraphConfig> = {}): GraphConfig {
  return {
    graphId: 'test-graph',
    userId: 'test-user',
    isDefault: false,
    name: 'Test Graph',
    description: 'A test graph',
    tier: 4,
    nodes: [
      { id: 'n1', config: { nodeId: 'context' } },
      { id: 'n2', config: { nodeId: 'respond' } },
    ],
    edges: [
      { from: '__start__', to: 'n1' },
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: '__end__' },
    ],
    ...over,
  };
}

function findError(r: ValidationResult, code: string) {
  return r.errors.find(e => e.code === code);
}
function findWarn(r: ValidationResult, code: string) {
  return r.warnings.find(w => w.code === code);
}

// ---------------------------------------------------------------------------
// Top-level shape
// ---------------------------------------------------------------------------

describe('validateGraphConfig — top level', () => {
  test('happy path — clean graph passes with no errors', async () => {
    const r = await validateGraphConfig(baseConfig());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('null config → MISSING_CONFIG (and short-circuits)', async () => {
    const r = await validateGraphConfig(null);
    expect(r.valid).toBe(false);
    expect(findError(r, 'MISSING_CONFIG')).toBeDefined();
  });

  test('undefined config → MISSING_CONFIG', async () => {
    const r = await validateGraphConfig(undefined);
    expect(r.valid).toBe(false);
    expect(findError(r, 'MISSING_CONFIG')).toBeDefined();
  });

  test('missing graphId → MISSING_GRAPH_ID', async () => {
    const r = await validateGraphConfig(baseConfig({ graphId: '' }));
    expect(findError(r, 'MISSING_GRAPH_ID')).toBeDefined();
  });

  test('whitespace-only graphId → MISSING_GRAPH_ID', async () => {
    const r = await validateGraphConfig(baseConfig({ graphId: '   ' }));
    expect(findError(r, 'MISSING_GRAPH_ID')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

describe('validateGraphConfig — nodes', () => {
  test('empty nodes array → NO_NODES error', async () => {
    const r = await validateGraphConfig(baseConfig({ nodes: [] }));
    expect(findError(r, 'NO_NODES')).toBeDefined();
  });

  test('missing nodes field → NO_NODES error', async () => {
    const r = await validateGraphConfig(
      baseConfig({ nodes: undefined as unknown as GraphConfig['nodes'] }),
    );
    expect(findError(r, 'NO_NODES')).toBeDefined();
  });

  test('node missing id → NODE_MISSING_ID', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          { id: '', config: { nodeId: 'context' } } as unknown as GraphConfig['nodes'][number],
        ],
      }),
    );
    expect(findError(r, 'NODE_MISSING_ID')).toBeDefined();
  });

  test('duplicate node ids → DUPLICATE_NODE_ID', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          { id: 'dupe', config: { nodeId: 'context' } },
          { id: 'dupe', config: { nodeId: 'respond' } },
        ],
        edges: [{ from: '__start__', to: 'dupe' }, { from: 'dupe', to: '__end__' }],
      }),
    );
    const issue = findError(r, 'DUPLICATE_NODE_ID');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('dupe');
  });

  test('single-node graph compiles cleanly', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [{ id: 'only', config: { nodeId: 'respond' } }],
        edges: [
          { from: '__start__', to: 'only' },
          { from: 'only', to: '__end__' },
        ],
      }),
    );
    expect(r.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

describe('validateGraphConfig — edges', () => {
  test('empty edges → NO_EDGES error', async () => {
    const r = await validateGraphConfig(baseConfig({ edges: [] }));
    expect(findError(r, 'NO_EDGES')).toBeDefined();
  });

  test('edge with unknown from → EDGE_UNKNOWN_FROM', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        edges: [
          { from: '__start__', to: 'n1' },
          { from: 'ghost', to: 'n2' },
          { from: 'n2', to: '__end__' },
        ],
      }),
    );
    const issue = findError(r, 'EDGE_UNKNOWN_FROM');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('ghost');
  });

  test('edge with unknown to → EDGE_UNKNOWN_TO', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        edges: [
          { from: '__start__', to: 'n1' },
          { from: 'n1', to: 'phantom' },
          { from: 'n2', to: '__end__' },
        ],
      }),
    );
    expect(findError(r, 'EDGE_UNKNOWN_TO')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Conditional edges
// ---------------------------------------------------------------------------

describe('validateGraphConfig — conditional edges', () => {
  test('conditional with no targets and no `to` → CONDITIONAL_MISSING_TARGETS', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        edges: [
          { from: '__start__', to: 'n1' },
          { from: 'n1', condition: 'state.foo' },
          { from: 'n2', to: '__end__' },
        ],
      }),
    );
    expect(findError(r, 'CONDITIONAL_MISSING_TARGETS')).toBeDefined();
  });

  test('conditional with targets but no fallback → warning CONDITIONAL_MISSING_FALLBACK', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        edges: [
          { from: '__start__', to: 'n1' },
          {
            from: 'n1',
            condition: 'state.foo',
            targets: { yes: 'n2' },
          },
          { from: 'n2', to: '__end__' },
        ],
      }),
    );
    expect(findWarn(r, 'CONDITIONAL_MISSING_FALLBACK')).toBeDefined();
  });

  test('conditional with unknown target → EDGE_UNKNOWN_TARGET', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        edges: [
          { from: '__start__', to: 'n1' },
          {
            from: 'n1',
            condition: 'state.foo',
            targets: { yes: 'noSuchNode' },
            fallback: 'n2',
          },
          { from: 'n2', to: '__end__' },
        ],
      }),
    );
    const issue = findError(r, 'EDGE_UNKNOWN_TARGET');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('noSuchNode');
  });

  test('conditional with unknown fallback → EDGE_UNKNOWN_FALLBACK', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        edges: [
          { from: '__start__', to: 'n1' },
          {
            from: 'n1',
            condition: 'state.foo',
            targets: { yes: 'n2' },
            fallback: 'phantom',
          },
          { from: 'n2', to: '__end__' },
        ],
      }),
    );
    expect(findError(r, 'EDGE_UNKNOWN_FALLBACK')).toBeDefined();
  });

  test('safe condition expressions accepted', async () => {
    const validExprs = [
      "state.foo === 'bar'",
      'state.count > 5',
      'state.a && state.b',
      'state.a || state.b',
      'state.deep.nested.value !== null',
    ];
    for (const expr of validExprs) {
      const r = await validateGraphConfig(
        baseConfig({
          edges: [
            { from: '__start__', to: 'n1' },
            {
              from: 'n1',
              condition: expr,
              targets: { true: 'n2' },
              fallback: 'n2',
            },
            { from: 'n2', to: '__end__' },
          ],
        }),
      );
      const e = findError(r, 'CONDITION_BAD_SYNTAX');
      expect(e, `expected ${expr} to pass syntax check`).toBeUndefined();
    }
  });

  test('unsafe condition → CONDITION_BAD_SYNTAX', async () => {
    const unsafeExprs = [
      'eval("evil")',
      'state.foo.bar.baz.constructor.name',
      'state.x.__proto__',
      'function() { return 1 }',
    ];
    for (const expr of unsafeExprs) {
      const r = await validateGraphConfig(
        baseConfig({
          edges: [
            { from: '__start__', to: 'n1' },
            {
              from: 'n1',
              condition: expr,
              targets: { true: 'n2' },
              fallback: 'n2',
            },
            { from: 'n2', to: '__end__' },
          ],
        }),
      );
      expect(findError(r, 'CONDITION_BAD_SYNTAX'), `expected ${expr} to be flagged`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Parallel + Join
// ---------------------------------------------------------------------------

describe('validateGraphConfig — parallel & join', () => {
  test('valid parallel + join roundtrip passes', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          { id: 'start', config: { nodeId: 'context' } },
          { id: 'a', config: { nodeId: 'context' } },
          { id: 'b', config: { nodeId: 'context' } },
          { id: 'final', config: { nodeId: 'respond' } },
        ],
        edges: [
          { from: '__start__', to: 'start' },
          { from: 'start', parallel: ['a', 'b'] },
          { from: '__join__', join: ['a', 'b'], to: 'final' },
          { from: 'final', to: '__end__' },
        ],
      }),
    );
    expect(r.valid).toBe(true);
  });

  test('parallel with empty array → PARALLEL_EMPTY', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        edges: [
          { from: '__start__', to: 'n1' },
          { from: 'n1', parallel: [] },
          { from: 'n2', to: '__end__' },
        ],
      }),
    );
    expect(findError(r, 'PARALLEL_EMPTY')).toBeDefined();
  });

  test('parallel with unknown target → PARALLEL_UNKNOWN_TARGET', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        edges: [
          { from: '__start__', to: 'n1' },
          { from: 'n1', parallel: ['phantom'] },
          { from: 'n2', to: '__end__' },
        ],
      }),
    );
    expect(findError(r, 'PARALLEL_UNKNOWN_TARGET')).toBeDefined();
  });

  test('join with empty array → JOIN_EMPTY', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        edges: [
          { from: '__start__', to: 'n1' },
          { from: 'n1', parallel: ['n2'] },
          { from: '__join__', join: [], to: 'n2' },
        ],
      }),
    );
    expect(findError(r, 'JOIN_EMPTY')).toBeDefined();
  });

  test('join with no matching parallel → JOIN_WITHOUT_PARALLEL', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        edges: [
          { from: '__start__', to: 'n1' },
          { from: 'n1', to: 'n2' },
          { from: '__join__', join: ['n1'], to: 'n2' },
        ],
      }),
    );
    expect(findError(r, 'JOIN_WITHOUT_PARALLEL')).toBeDefined();
  });

  test('join referencing source not reachable from parallel → JOIN_SOURCE_NOT_PARALLEL', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          { id: 'start', config: { nodeId: 'context' } },
          { id: 'a', config: { nodeId: 'context' } },
          { id: 'b', config: { nodeId: 'context' } },
          { id: 'rogue', config: { nodeId: 'context' } },
          { id: 'final', config: { nodeId: 'respond' } },
        ],
        edges: [
          { from: '__start__', to: 'start' },
          { from: 'start', parallel: ['a', 'b'] },
          // rogue has no parallel ancestor, but appears in join
          { from: '__join__', join: ['a', 'b', 'rogue'], to: 'final' },
          { from: 'final', to: '__end__' },
        ],
      }),
    );
    expect(findError(r, 'JOIN_SOURCE_NOT_PARALLEL')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Step-level checks
// ---------------------------------------------------------------------------

describe('validateGraphConfig — step-level checks', () => {
  test('inline step missing type → STEP_MISSING_TYPE', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [{ config: {} }],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findError(r, 'STEP_MISSING_TYPE')).toBeDefined();
  });

  test('inline step with unknown type → STEP_UNKNOWN_TYPE', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [{ type: 'wat', config: {} }],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findError(r, 'STEP_UNKNOWN_TYPE')).toBeDefined();
  });

  test('neuron step missing userPrompt → NEURON_MISSING_PROMPT', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'neuron',
                  config: { neuronId: 'red-neuron', outputField: 'x' },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findError(r, 'NEURON_MISSING_PROMPT')).toBeDefined();
  });

  test('neuron step missing outputField → STEP_MISSING_OUTPUT_FIELD', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'neuron',
                  config: { neuronId: 'red-neuron', userPrompt: 'hi' },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findError(r, 'STEP_MISSING_OUTPUT_FIELD')).toBeDefined();
  });

  test('tool step missing toolName → TOOL_MISSING_NAME', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                { type: 'tool', config: { outputField: 'x' } },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findError(r, 'TOOL_MISSING_NAME')).toBeDefined();
  });

  test('tool step with unknown toolName but no toolCheck → no warning', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'tool',
                  config: { toolName: 'mystery_tool', outputField: 'x' },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findWarn(r, 'TOOL_UNKNOWN')).toBeUndefined();
  });

  test('tool step with toolCheck flagging unknown → warning TOOL_UNKNOWN', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'tool',
                  config: { toolName: 'mystery_tool', outputField: 'x' },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
      { toolCheck: { has: () => false } },
    );
    expect(findWarn(r, 'TOOL_UNKNOWN')).toBeDefined();
  });

  test('graph step missing graphId → GRAPH_STEP_MISSING_ID', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'graph',
                  config: { outputField: 'x' },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findError(r, 'GRAPH_STEP_MISSING_ID')).toBeDefined();
  });

  test('loop step missing maxIterations → LOOP_MISSING_MAX', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'loop',
                  config: {
                    exitCondition: 'state.done',
                    steps: [
                      { type: 'transform', config: { operation: 'set', outputField: 'x' } },
                    ],
                  },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findError(r, 'LOOP_MISSING_MAX')).toBeDefined();
  });

  test('connection step missing both connectionId/providerId → CONNECTION_MISSING_REF', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'connection',
                  config: { outputField: 'cx' },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findError(r, 'CONNECTION_MISSING_REF')).toBeDefined();
  });

  test('delay step with bad ms → DELAY_BAD_MS', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [{ type: 'delay', config: { ms: -50 } }],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findError(r, 'DELAY_BAD_MS')).toBeDefined();
  });

  test('per-step inline condition with bad syntax → STEP_CONDITION_BAD_SYNTAX', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'transform',
                  condition: 'eval("evil")',
                  config: { operation: 'set', outputField: 'x' },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findError(r, 'STEP_CONDITION_BAD_SYNTAX')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Optional registry checks
// ---------------------------------------------------------------------------

describe('validateGraphConfig — registry hooks', () => {
  test('neuronCheck flagging unknown neuronId → NEURON_UNKNOWN error', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'neuron',
                  config: {
                    neuronId: 'phantom-neuron',
                    userPrompt: 'x',
                    outputField: 'y',
                  },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
      { neuronCheck: { has: () => false } },
    );
    expect(findError(r, 'NEURON_UNKNOWN')).toBeDefined();
  });

  test('nodeCheck flagging unknown graph-step nodeId → NODE_UNKNOWN error', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          { id: 'n1', config: { nodeId: 'phantomA' } },
          { id: 'n2', config: { nodeId: 'phantomB' } },
        ],
      }),
      { nodeCheck: { has: () => false } },
    );
    const issues = r.errors.filter(e => e.code === 'NODE_UNKNOWN');
    expect(issues.length).toBe(2);
  });

  test('nodeCheck returning true → no NODE_UNKNOWN error', async () => {
    const r = await validateGraphConfig(baseConfig(), {
      nodeCheck: { has: () => true },
    });
    expect(findError(r, 'NODE_UNKNOWN')).toBeUndefined();
  });

  test('async neuronCheck → resolved correctly', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'neuron',
                  config: { neuronId: 'red-neuron', userPrompt: 'x', outputField: 'y' },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
      { neuronCheck: { has: async (id) => id === 'red-neuron' } },
    );
    expect(findError(r, 'NEURON_UNKNOWN')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Style warnings
// ---------------------------------------------------------------------------

describe('validateGraphConfig — style warnings', () => {
  test('orphaned node (no incoming edge) → NODE_UNREFERENCED warning', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          { id: 'n1', config: { nodeId: 'context' } },
          { id: 'n2', config: { nodeId: 'respond' } },
          { id: 'n3', config: { nodeId: 'orphan' } },
        ],
        // n3 has no incoming edge
        edges: [
          { from: '__start__', to: 'n1' },
          { from: 'n1', to: 'n2' },
          { from: 'n2', to: '__end__' },
        ],
      }),
    );
    const warn = findWarn(r, 'NODE_UNREFERENCED');
    expect(warn).toBeDefined();
    expect(warn!.nodeId).toBe('n3');
  });

  test('long template chain → LONG_TEMPLATE_CHAIN warning', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'neuron',
                  config: {
                    userPrompt: 'Result: {{state.a.b.c.d.e.f.g}}',
                    outputField: 'res',
                  },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findWarn(r, 'LONG_TEMPLATE_CHAIN')).toBeDefined();
  });

  test('short template chain → no warning', async () => {
    const r = await validateGraphConfig(
      baseConfig({
        nodes: [
          {
            id: 'n1',
            config: {
              nodeId: 'inline',
              steps: [
                {
                  type: 'neuron',
                  config: {
                    userPrompt: 'Hello {{state.user.name}}',
                    outputField: 'res',
                  },
                },
              ],
            },
          },
          { id: 'n2', config: { nodeId: 'respond' } },
        ],
      }),
    );
    expect(findWarn(r, 'LONG_TEMPLATE_CHAIN')).toBeUndefined();
  });

  test('missing description → GRAPH_MISSING_DESCRIPTION warning', async () => {
    const r = await validateGraphConfig(baseConfig({ description: '' }));
    expect(findWarn(r, 'GRAPH_MISSING_DESCRIPTION')).toBeDefined();
  });

  test('missing name → GRAPH_MISSING_NAME warning', async () => {
    const r = await validateGraphConfig(baseConfig({ name: '' }));
    expect(findWarn(r, 'GRAPH_MISSING_NAME')).toBeDefined();
  });

  test('large graph → LARGE_GRAPH warning', async () => {
    const big = baseConfig({
      nodes: Array.from({ length: 25 }, (_, i) => ({
        id: `n${i}`,
        config: { nodeId: 'context' },
      })),
      edges: [
        { from: '__start__', to: 'n0' },
        ...Array.from({ length: 24 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
        { from: 'n24', to: '__end__' },
      ],
    });
    const r = await validateGraphConfig(big);
    expect(findWarn(r, 'LARGE_GRAPH')).toBeDefined();
  });

  test('bad tier (out of range) → BAD_TIER error', async () => {
    const r = await validateGraphConfig(baseConfig({ tier: 99 }));
    expect(findError(r, 'BAD_TIER')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-error: collects ALL issues, doesn't fail-fast
// ---------------------------------------------------------------------------

describe('validateGraphConfig — collects all errors', () => {
  test('graph with many problems surfaces multiple errors at once', async () => {
    const r = await validateGraphConfig({
      graphId: 'broken-graph',
      userId: 'u',
      isDefault: false,
      name: '',
      description: '',
      tier: 99,
      nodes: [
        { id: 'n1', config: { nodeId: 'context' } },
        { id: 'n1', config: { nodeId: 'context' } }, // duplicate
        {
          id: 'n2',
          config: {
            nodeId: 'inline',
            steps: [
              { type: 'tool', config: { outputField: 'x' } }, // missing toolName
              { type: 'wat', config: {} }, // unknown step type
              {
                type: 'neuron',
                config: { neuronId: '', outputField: 'y' }, // bad id + missing prompt
              },
            ],
          },
        },
      ],
      edges: [
        { from: '__start__', to: 'phantom' }, // unknown to
        {
          from: 'n1',
          condition: 'eval("evil")', // bad syntax
          targets: { yes: 'n2' },
        },
      ],
    });

    expect(r.valid).toBe(false);
    // Ought to flag at least: BAD_TIER, DUPLICATE_NODE_ID,
    // EDGE_UNKNOWN_TO, CONDITION_BAD_SYNTAX, TOOL_MISSING_NAME,
    // NEURON_BAD_ID, NEURON_MISSING_PROMPT, STEP_UNKNOWN_TYPE.
    const codes = new Set(r.errors.map(e => e.code));
    expect(codes.has('BAD_TIER')).toBe(true);
    expect(codes.has('DUPLICATE_NODE_ID')).toBe(true);
    expect(codes.has('EDGE_UNKNOWN_TO')).toBe(true);
    expect(codes.has('CONDITION_BAD_SYNTAX')).toBe(true);
    expect(codes.has('TOOL_MISSING_NAME')).toBe(true);
    expect(codes.has('NEURON_BAD_ID')).toBe(true);
    expect(codes.has('NEURON_MISSING_PROMPT')).toBe(true);
    expect(codes.has('STEP_UNKNOWN_TYPE')).toBe(true);

    // Warnings include both name + description missing
    const warnCodes = new Set(r.warnings.map(w => w.code));
    expect(warnCodes.has('GRAPH_MISSING_NAME')).toBe(true);
    expect(warnCodes.has('GRAPH_MISSING_DESCRIPTION')).toBe(true);
  });

  test('valid: false implies errors array is non-empty', async () => {
    const r = await validateGraphConfig({} as GraphConfig);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test('valid: true implies errors array empty', async () => {
    const r = await validateGraphConfig(baseConfig());
    expect(r.valid).toBe(true);
    expect(r.errors.length).toBe(0);
  });
});
