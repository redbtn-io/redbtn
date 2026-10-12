/**
 * Graph / node / automation EDIT tools under a capability profile (0.0.295).
 *
 * Before this, graph_patch / update_graph / publish_graph / delete_graph,
 * node_patch / update_node / delete_node and update_automation /
 * enable_automation / disable_automation were unmapped in DATA_TOOL_RULES, so a
 * profiled (jailed) operator could rewrite any graph, node or automation its
 * user owns. Now:
 *   - graph_patch / update_graph / publish_graph -> graph:write   keyed by graphId
 *   - delete_graph                               -> graph:delete  keyed by graphId
 *   - node_patch / update_node                   -> node:write    keyed by nodeId
 *   - delete_node                                -> node:delete   keyed by nodeId
 *   - update_automation / enable_automation /
 *     disable_automation                         -> automation:write keyed by automationId
 * Unprofiled runs stay unrestricted (these resources are fail-open).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { enforceToolCapability, normalizeProfile } from '../../src/lib/permissions/enforce';
import { DATA_TOOL_RULES } from '../../src/lib/permissions/tool-map';
import { CapabilityDeniedError, type CapabilityProfile } from '../../src/lib/permissions/types';
import { NativeToolRegistry } from '../../src/lib/tools/native-registry';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';

function deniedBy(profile: CapabilityProfile | null, tool: string, args: Record<string, unknown>): CapabilityDeniedError | null {
  try {
    enforceToolCapability(profile, tool, args);
    return null;
  } catch (err) {
    if (err instanceof CapabilityDeniedError) return err;
    throw err;
  }
}

/** What redOps writes for an editable graph: `graph:read/write@<graphId>`. */
const OPERATOR: CapabilityProfile = {
  name: 'redops-op-test',
  capabilities: [
    { resource: 'graph', actions: ['read', 'write'], selector: 'become-dispatcher-tick' },
    { resource: 'graph', actions: ['read', 'write'], selector: 'lane-*' },
    { resource: 'graph', actions: ['execute'], selector: '*' },
    { resource: 'node', actions: ['write'], selector: 'become-dispatcher-tick-*' },
    { resource: 'automation', actions: ['read', 'execute'], selector: 'become-*' },
    { resource: 'automation', actions: ['write'], selector: 'become-builder-qa-lane' },
  ],
};

describe('rule table', () => {
  it('maps every edit tool to the agreed resource, action and key', () => {
    const expected: Record<string, [string, string]> = {
      graph_patch: ['graph', 'write'],
      update_graph: ['graph', 'write'],
      publish_graph: ['graph', 'write'],
      delete_graph: ['graph', 'delete'],
      node_patch: ['node', 'write'],
      update_node: ['node', 'write'],
      delete_node: ['node', 'delete'],
      update_automation: ['automation', 'write'],
      enable_automation: ['automation', 'write'],
      disable_automation: ['automation', 'write'],
    };
    for (const [tool, [resource, action]] of Object.entries(expected)) {
      const rule = DATA_TOOL_RULES[tool];
      expect(rule, tool).toBeDefined();
      expect(rule.resource, tool).toBe(resource);
      expect(rule.action, tool).toBe(action);
    }
    expect(DATA_TOOL_RULES.graph_patch.extract({ graphId: 'g1', ops: [] })).toEqual({ addresses: ['g1'] });
    expect(DATA_TOOL_RULES.node_patch.extract({ nodeId: 'n1', ops: [] })).toEqual({ addresses: ['n1'] });
    expect(DATA_TOOL_RULES.update_automation.extract({ automationId: 'a1' })).toEqual({ addresses: ['a1'] });
  });
});

describe('unprofiled runs stay unrestricted', () => {
  it.each(Object.keys({
    graph_patch: 1, update_graph: 1, publish_graph: 1, delete_graph: 1,
    node_patch: 1, update_node: 1, delete_node: 1,
    update_automation: 1, enable_automation: 1, disable_automation: 1,
  }))('%s', (tool) => {
    expect(deniedBy(null, tool, { graphId: 'x', nodeId: 'x', automationId: 'x' })).toBeNull();
  });
});

describe('graph edits are keyed by graphId', () => {
  it('allows graph_patch / update_graph / publish_graph on a granted graph (exact and prefix selectors)', () => {
    for (const tool of ['graph_patch', 'update_graph', 'publish_graph']) {
      expect(deniedBy(OPERATOR, tool, { graphId: 'become-dispatcher-tick' })).toBeNull();
      expect(deniedBy(OPERATOR, tool, { graphId: 'lane-builder' })).toBeNull();
    }
  });

  it('denies them on any other graph, naming the address and the allowed selectors', () => {
    const err = deniedBy(OPERATOR, 'graph_patch', { graphId: 'a4JcJpRij9DV', ops: [] });
    expect(err).not.toBeNull();
    expect(err!.resource).toBe('graph');
    expect(err!.action).toBe('write');
    expect(err!.address).toBe('a4JcJpRij9DV');
    expect(err!.message).toContain('become-dispatcher-tick, lane-*');
    expect(deniedBy(OPERATOR, 'update_graph', { graphId: 'red-assistant', patch: {} })).not.toBeNull();
    expect(deniedBy(OPERATOR, 'publish_graph', { graphId: 'other' })).not.toBeNull();
  });

  it('graph:execute does not imply write; write does not imply delete', () => {
    const execOnly: CapabilityProfile = { name: 'exec-only', capabilities: [{ resource: 'graph', actions: ['execute'], selector: '*' }] };
    expect(deniedBy(execOnly, 'invoke_graph', { graphId: 'g' })).toBeNull();
    expect(deniedBy(execOnly, 'update_graph', { graphId: 'g' })).not.toBeNull();
    expect(deniedBy(OPERATOR, 'delete_graph', { graphId: 'become-dispatcher-tick' })).not.toBeNull();
    const del: CapabilityProfile = { name: 'del', capabilities: [{ resource: 'graph', actions: ['delete'], selector: 'tmp-*' }] };
    expect(deniedBy(del, 'delete_graph', { graphId: 'tmp-1' })).toBeNull();
    expect(deniedBy(del, 'delete_graph', { graphId: 'prod-1' })).not.toBeNull();
  });

  it('a call with no graphId is unscoped and needs a wildcard write grant', () => {
    expect(deniedBy(OPERATOR, 'graph_patch', { ops: [] })?.address).toBe('*');
    const all: CapabilityProfile = { name: 'all', capabilities: [{ resource: 'graph', actions: ['write'], selector: '*' }] };
    expect(deniedBy(all, 'graph_patch', { ops: [] })).toBeNull();
  });
});

describe('node edits are keyed by nodeId (own `node` resource)', () => {
  it('allows node_patch / update_node inside the granted prefix, denies outside', () => {
    expect(deniedBy(OPERATOR, 'node_patch', { nodeId: 'become-dispatcher-tick-operator', ops: [] })).toBeNull();
    expect(deniedBy(OPERATOR, 'update_node', { nodeId: 'become-dispatcher-tick-prompt', patch: {} })).toBeNull();
    const err = deniedBy(OPERATOR, 'node_patch', { nodeId: 'context', ops: [] });
    expect(err?.resource).toBe('node');
    expect(err?.address).toBe('context');
  });

  it('graph:write does not cover node documents, and node:write does not cover delete', () => {
    const graphOnly: CapabilityProfile = { name: 'g', capabilities: [{ resource: 'graph', actions: ['write'], selector: '*' }] };
    expect(deniedBy(graphOnly, 'update_node', { nodeId: 'n' })).not.toBeNull();
    expect(deniedBy(OPERATOR, 'delete_node', { nodeId: 'become-dispatcher-tick-operator' })).not.toBeNull();
  });

  it('normalizeProfile keeps node grants (a dropped grant would silently deny)', () => {
    const p = normalizeProfile({ name: 'n', capabilities: [{ resource: 'node', actions: ['write', 'delete'], selector: 'g-*' }] });
    expect(p?.capabilities).toEqual([{ resource: 'node', actions: ['write', 'delete'], selector: 'g-*' }]);
  });
});

describe('automation edits are keyed by automationId', () => {
  it('update / enable / disable need automation:write on that id', () => {
    for (const tool of ['update_automation', 'enable_automation', 'disable_automation']) {
      expect(deniedBy(OPERATOR, tool, { automationId: 'become-builder-qa-lane' })).toBeNull();
      const err = deniedBy(OPERATOR, tool, { automationId: 'become-supervisor-lane' });
      expect(err?.resource).toBe('automation');
      expect(err?.action).toBe('write');
    }
  });

  it('read/execute grants (what Become Ops holds today) still trigger but no longer edit', () => {
    const becomeOpsToday: CapabilityProfile = {
      name: 'redops-op_ry28guwy',
      capabilities: [{ resource: 'automation', actions: ['read', 'execute'], selector: 'become-*' }],
    };
    expect(deniedBy(becomeOpsToday, 'trigger_automation', { automationId: 'become-builder-qa-lane' })).toBeNull();
    expect(deniedBy(becomeOpsToday, 'update_automation', { automationId: 'become-builder-qa-lane' })).not.toBeNull();
    expect(deniedBy(becomeOpsToday, 'graph_patch', { graphId: 'become-builder-qa-tick' })?.message)
      .toContain('This agent has no graph write grants');
  });
});

describe('dispatch chokepoint (NativeToolRegistry.callTool)', () => {
  const RUN_ID = 'test-run-graph-edit-grants';
  afterEach(() => runControlRegistry.unregister(RUN_ID));

  function registryWith(name: string, ran: Record<string, boolean>): NativeToolRegistry {
    const registry = new NativeToolRegistry();
    registry.register(name, {
      description: 'stub',
      inputSchema: { type: 'object' },
      handler: async () => {
        ran[name] = true;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    return registry;
  }

  const ctx = { publisher: null, state: { runId: RUN_ID }, runId: RUN_ID, nodeId: null, toolId: 't1', abortSignal: null };

  it('denies graph_patch on an ungranted graph before the handler runs, allows a granted one', async () => {
    runControlRegistry.register(RUN_ID, 'test-worker', { capabilityProfile: OPERATOR });
    const ran: Record<string, boolean> = {};
    const registry = registryWith('graph_patch', ran);
    const denied = await registry.callTool('graph_patch', { graphId: 'someone-elses', ops: [] }, ctx);
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('Permission denied');
    expect(ran.graph_patch).toBeUndefined();
    const ok = await registry.callTool('graph_patch', { graphId: 'become-dispatcher-tick', ops: [] }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(ran.graph_patch).toBe(true);
  });

  it('leaves an unprofiled run alone', async () => {
    runControlRegistry.register(RUN_ID, 'test-worker');
    const ran: Record<string, boolean> = {};
    const registry = registryWith('update_automation', ran);
    const res = await registry.callTool('update_automation', { automationId: 'anything' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(ran.update_automation).toBe(true);
  });
});
