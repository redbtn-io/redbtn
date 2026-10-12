/**
 * `toolsFrom` — runtime tool lists for neuron steps (pure resolution).
 *
 * Contract under test (executors/toolsFrom.ts):
 *   - a dot path into run state; a leading `state.` is accepted;
 *   - an ARRAY of ToolRefs found there is appended AFTER the literal `tools`,
 *     de-duplicated by ref identity;
 *   - missing / non-array -> ignored with a warning, never an error;
 *     malformed entries are skipped with a warning;
 *   - strings are taken literally (no template rendering);
 *   - the literal list is never modified.
 *
 * No database, no registry, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveToolsFrom,
  summariseToolsFrom,
  normaliseToolsFromPath,
  isDotPath,
} from '../../src/lib/nodes/universal/executors/toolsFrom';
import { toolRefKey, isToolRefShape } from '../../src/lib/tools/tool-resolver';
import { validateGraphConfig } from '../../src/lib/graphs/validateGraphConfig';
import { validateUniversalNodeConfig } from '../../src/lib/nodes/universal/universalNode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('toolRefKey — ref identity used for de-duplication', () => {
  it('treats bare, object and explicit-native forms of a native tool as one ref', () => {
    expect(toolRefKey('now')).toBe('native:now');
    expect(toolRefKey({ name: 'now' })).toBe('native:now');
    expect(toolRefKey({ name: 'now', source: 'native' })).toBe('native:now');
    expect(toolRefKey({ name: 'now', description: 'override' })).toBe('native:now');
  });

  it('treats prefixed strings and {name, source} objects for mcp/graph/hosted as one ref', () => {
    expect(toolRefKey('mcp:redboard.redboard_card_run')).toBe('mcp:redboard.redboard_card_run');
    expect(toolRefKey({ name: 'redboard.redboard_card_run', source: 'mcp' })).toBe('mcp:redboard.redboard_card_run');
    expect(toolRefKey({ name: 'mcp:redboard.redboard_card_run' })).toBe('mcp:redboard.redboard_card_run');
    expect(toolRefKey('graph:my-sub')).toBe('graph:my-sub');
    expect(toolRefKey({ name: 'my-sub', source: 'graph' })).toBe('graph:my-sub');
    expect(toolRefKey('hosted:web_search')).toBe('hosted:web_search');
  });

  it('keeps different tools apart', () => {
    expect(toolRefKey('mcp:a.x')).not.toBe(toolRefKey('mcp:b.x'));
    expect(toolRefKey('web_search')).not.toBe(toolRefKey('hosted:web_search'));
  });
});

describe('isToolRefShape', () => {
  it('accepts the shapes `tools` accepts', () => {
    for (const ok of ['now', 'mcp:x', 'mcp:s.t', 'graph:g', 'hosted:web_search', { name: 'now' },
      { name: 'x', source: 'mcp' }, { name: 'g', source: 'graph', description: 'd' }]) {
      expect(isToolRefShape(ok)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const bad of ['', 42, null, undefined, true, [], ['now'], {}, { name: '' }, { name: 7 },
      { name: 'x', source: 'bogus' }, { name: 'x', description: 3 }]) {
      expect(isToolRefShape(bad)).toBe(false);
    }
  });
});

describe('normaliseToolsFromPath / isDotPath', () => {
  it('treats undefined, null and blank strings as absent (no error)', () => {
    expect(normaliseToolsFromPath(undefined)).toEqual({ path: null });
    expect(normaliseToolsFromPath(null)).toEqual({ path: null });
    expect(normaliseToolsFromPath('')).toEqual({ path: null });
    expect(normaliseToolsFromPath('   ')).toEqual({ path: null });
  });

  it('accepts dot paths and strips a leading `state.`', () => {
    expect(normaliseToolsFromPath('data.opTools')).toEqual({ path: 'data.opTools' });
    expect(normaliseToolsFromPath(' data.opTools ')).toEqual({ path: 'data.opTools' });
    expect(normaliseToolsFromPath('state.data.opTools')).toEqual({ path: 'data.opTools' });
    expect(normaliseToolsFromPath('data.op-tools.0')).toEqual({ path: 'data.op-tools.0' });
  });

  it('flags non-strings and non-paths as errors', () => {
    expect(normaliseToolsFromPath(['data.x']).error).toMatch(/must be a string dot path/);
    expect(normaliseToolsFromPath(5).error).toMatch(/must be a string dot path/);
    expect(normaliseToolsFromPath('{{state.data.x}}').error).toMatch(/not a dot path/);
    expect(normaliseToolsFromPath('data..x').error).toMatch(/not a dot path/);
    expect(normaliseToolsFromPath('data.x y').error).toMatch(/not a dot path/);
    expect(isDotPath('data.x')).toBe(true);
    expect(isDotPath('.data')).toBe(false);
    expect(isDotPath('data.')).toBe(false);
  });
});

describe('resolveToolsFrom — merge, de-dup, ignore', () => {
  it('appends runtime refs AFTER the literal tools, in order', () => {
    const res = resolveToolsFrom(
      { tools: ['get_global_state', 'mcp:redboard.redboard_cards_list'], toolsFrom: 'data.opTools' },
      { data: { opTools: ['now', 'mcp:redboard.redboard_card_run', { name: 'g1', source: 'graph' }] } },
    );
    expect(res.path).toBe('data.opTools');
    expect(res.tools).toEqual([
      'get_global_state',
      'mcp:redboard.redboard_cards_list',
      'now',
      'mcp:redboard.redboard_card_run',
      { name: 'g1', source: 'graph' },
    ]);
    expect(res.added).toHaveLength(3);
    expect(res.warnings).toEqual([]);
  });

  it('de-duplicates by ref identity against the literal list and within the runtime list', () => {
    const res = resolveToolsFrom(
      { tools: ['now', { name: 'x', source: 'mcp' }], toolsFrom: 'data.rt' },
      { data: { rt: [{ name: 'now' }, 'mcp:x', 'web_search', { name: 'web_search', source: 'native' }, 'web_search'] } },
    );
    expect(res.tools).toEqual(['now', { name: 'x', source: 'mcp' }, 'web_search']);
    expect(res.added).toEqual(['web_search']);
    expect(res.duplicates).toBe(4);
    expect(res.warnings).toEqual([]);
  });

  it('works with no literal tools (tools: [] / tools missing)', () => {
    expect(resolveToolsFrom({ tools: [], toolsFrom: 'data.rtTools' }, { data: { rtTools: ['now'] } }).tools)
      .toEqual(['now']);
    expect(resolveToolsFrom({ toolsFrom: 'data.rtTools' }, { data: { rtTools: ['now'] } }).tools)
      .toEqual(['now']);
  });

  it('reads a `state.`-prefixed path the same way', () => {
    const res = resolveToolsFrom({ tools: [], toolsFrom: 'state.data.rt' }, { data: { rt: ['now'] } });
    expect(res.path).toBe('data.rt');
    expect(res.tools).toEqual(['now']);
  });

  it('takes strings literally — no template rendering', () => {
    const res = resolveToolsFrom(
      { tools: [], toolsFrom: 'data.rt' },
      { data: { rt: ['{{state.data.toolName}}'], toolName: 'now' } },
    );
    expect(res.tools).toEqual(['{{state.data.toolName}}']);
  });

  it('ignores a missing value with a warning (undefined and null)', () => {
    const missing = resolveToolsFrom({ tools: ['now'], toolsFrom: 'data.nope' }, { data: {} });
    expect(missing.tools).toEqual(['now']);
    expect(missing.added).toEqual([]);
    expect(missing.warnings).toHaveLength(1);
    expect(missing.warnings[0]).toMatch(/"data\.nope" is missing from run state \(undefined\)/);

    const nul = resolveToolsFrom({ tools: ['now'], toolsFrom: 'data.rt' }, { data: { rt: null } });
    expect(nul.tools).toEqual(['now']);
    expect(nul.warnings[0]).toMatch(/missing from run state \(null\)/);

    // An intermediate segment that is not an object is "missing", not a crash.
    const deep = resolveToolsFrom({ tools: [], toolsFrom: 'data.a.b.c' }, { data: { a: 3 } });
    expect(deep.tools).toEqual([]);
    expect(deep.warnings[0]).toMatch(/missing/);
  });

  it('ignores a non-array value with a warning', () => {
    for (const value of ['now', '["now"]', 42, { name: 'now' }, true]) {
      const res = resolveToolsFrom({ tools: ['get_global_state'], toolsFrom: 'data.rt' }, { data: { rt: value } });
      expect(res.tools).toEqual(['get_global_state']);
      expect(res.added).toEqual([]);
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toMatch(/not an array of tool refs; ignored/);
    }
  });

  it('skips malformed entries with a warning and keeps the good ones', () => {
    const res = resolveToolsFrom(
      { tools: [], toolsFrom: 'data.rt' },
      { data: { rt: ['now', '', 7, null, { name: '' }, { name: 'x', source: 'nope' }, ['a'], 'mcp:s.t'] } },
    );
    expect(res.tools).toEqual(['now', 'mcp:s.t']);
    expect(res.warnings).toHaveLength(6);
    expect(res.warnings[0]).toMatch(/"data\.rt"\[1\] is not a tool ref/);
  });

  it('turns an unusable toolsFrom value into a warning, not an error', () => {
    const res = resolveToolsFrom({ tools: ['now'], toolsFrom: 12 as Any }, { data: {} });
    expect(res.tools).toEqual(['now']);
    expect(res.path).toBeNull();
    expect(res.warnings[0]).toMatch(/must be a string dot path.*ignored/);
  });

  it('is a no-op without toolsFrom (literal list returned as-is, non-array literal -> [])', () => {
    const literal = ['now'];
    const res = resolveToolsFrom({ tools: literal }, { data: {} });
    expect(res.tools).toBe(literal);
    expect(res.warnings).toEqual([]);
    expect(resolveToolsFrom({ tools: 'now' as Any }, {}).tools).toEqual([]);
  });

  it('never mutates the literal list or the state array', () => {
    const literal = ['now'];
    const rt = ['web_search'];
    resolveToolsFrom({ tools: literal, toolsFrom: 'data.rt' }, { data: { rt } });
    expect(literal).toEqual(['now']);
    expect(rt).toEqual(['web_search']);
  });

  it('summarises what it added for the run log', () => {
    const res = resolveToolsFrom({ tools: ['now'], toolsFrom: 'data.rt' }, { data: { rt: ['now', 'web_search'] } });
    expect(summariseToolsFrom(res)).toBe(
      'toolsFrom "data.rt" added 1 runtime tool: web_search (1 duplicate dropped); step offers 2 in total',
    );
  });
});

describe('validateGraphConfig — toolsFrom', () => {
  function graphWith(stepConfig: Record<string, unknown>) {
    return {
      graphId: 'g-tools-from',
      userId: 'u1',
      nodes: [
        {
          id: 'n1',
          type: 'universal',
          config: {
            steps: [
              { type: 'neuron', config: { userPrompt: 'hi', outputField: 'data.out', tools: [], ...stepConfig } },
            ],
          },
        },
      ],
      edges: [
        { from: '__start__', to: 'n1' },
        { from: 'n1', to: '__end__' },
      ],
    } as Any;
  }

  it('accepts a dot path, a state.-prefixed path, and an absent/blank value', async () => {
    for (const toolsFrom of ['data.rtTools', 'state.data.rtTools', '', undefined, null]) {
      const res = await validateGraphConfig(graphWith({ toolsFrom }));
      expect(res.errors.filter((e: Any) => e.code === 'NEURON_BAD_TOOLS_FROM')).toEqual([]);
    }
  });

  it('rejects a non-string or a non-path toolsFrom', async () => {
    for (const toolsFrom of [['now'], 3, '{{state.data.x}}', 'data x']) {
      const res = await validateGraphConfig(graphWith({ toolsFrom }));
      const codes = res.errors.map((e: Any) => e.code);
      expect(codes).toContain('NEURON_BAD_TOOLS_FROM');
      expect(res.valid).toBe(false);
    }
  });
});

describe('validateUniversalNodeConfig — toolsFrom', () => {
  const node = (toolsFrom: unknown) => ({
    steps: [{ type: 'neuron', config: { userPrompt: 'hi', outputField: 'data.out', toolsFrom } }],
  }) as Any;

  it('accepts a dot path and an absent value', () => {
    expect(() => validateUniversalNodeConfig(node('data.rt'))).not.toThrow();
    expect(() => validateUniversalNodeConfig(node(undefined))).not.toThrow();
  });

  it('throws for an unusable value', () => {
    expect(() => validateUniversalNodeConfig(node(['now']))).toThrow(/toolsFrom must be a string dot path/);
  });
});
