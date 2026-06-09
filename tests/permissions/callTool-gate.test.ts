/**
 * End-to-end capability gate at the native-tool dispatch chokepoint.
 *
 * Proves that `NativeToolRegistry.callTool` consults the run's capability
 * profile (resolved from the run control registry by runId) and:
 *   - lets unprofiled runs through untouched (backward compat),
 *   - allows in-prefix data ops for a profiled run,
 *   - returns a model-readable `isError` result for cross-prefix data ops,
 *   - leaves non-data tools ungated.
 *
 * We register a fake data tool whose handler records whether it ran, then drive
 * it through the registry with a registered run context. This avoids any real
 * HTTP/Chroma/Mongo while exercising the REAL gate code path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NativeToolRegistry } from '../../src/lib/tools/native-registry';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import type { CapabilityProfile } from '../../src/lib/permissions/types';

const RUN_ID = 'test-run-permissions-gate';

const coderJail: CapabilityProfile = {
  name: 'red-coder-jail',
  capabilities: [
    { resource: 'state', actions: ['read', 'write', 'create', 'delete'], selector: 'coder/*' },
    { resource: 'knowledge', actions: ['read', 'write', 'create', 'delete'], selector: 'coder/*' },
  ],
};

/** Build a fresh registry with a stub for the real `set_global_state` data
 *  tool plus a non-data tool, so the gate's tool-map lookup keys on real
 *  tool names without performing real I/O. */
function makeRegistry(): { registry: NativeToolRegistry; ran: Record<string, boolean> } {
  const registry = new NativeToolRegistry();
  const ran: Record<string, boolean> = {};

  // Real data-tool NAME (set_global_state is in DATA_TOOL_RULES) but a stub
  // handler — the gate runs before the handler, so the handler only runs if
  // the call was allowed.
  registry.register('set_global_state', {
    description: 'stub',
    inputSchema: { type: 'object' },
    handler: async () => {
      ran.set_global_state = true;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });

  registry.register('delete_namespace', {
    description: 'stub',
    inputSchema: { type: 'object' },
    handler: async () => {
      ran.delete_namespace = true;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });

  registry.register('add_document', {
    description: 'stub',
    inputSchema: { type: 'object' },
    handler: async () => {
      ran.add_document = true;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });

  // Non-data tool — should never be gated.
  registry.register('web_search', {
    description: 'stub',
    inputSchema: { type: 'object' },
    handler: async () => {
      ran.web_search = true;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });

  return { registry, ran };
}

function ctx(state: Record<string, unknown>) {
  return {
    publisher: null,
    state,
    runId: (state.runId as string) ?? null,
    nodeId: null,
    toolId: 't1',
    abortSignal: null,
  };
}

afterEach(() => {
  runControlRegistry.unregister(RUN_ID);
});

describe('callTool gate — unprofiled run (backward compat)', () => {
  beforeEach(() => {
    // Register a run WITHOUT a capability profile.
    runControlRegistry.register(RUN_ID, 'test-worker');
  });

  it('allows a cross-prefix state delete when there is no profile', async () => {
    const { registry, ran } = makeRegistry();
    const res = await registry.callTool(
      'delete_namespace',
      { namespace: 'finance' },
      ctx({ runId: RUN_ID }),
    );
    expect(res.isError).toBeFalsy();
    expect(ran.delete_namespace).toBe(true);
  });
});

describe('callTool gate — profiled run (jailed)', () => {
  beforeEach(() => {
    runControlRegistry.register(RUN_ID, 'test-worker', { capabilityProfile: coderJail });
  });

  it('(a) DENIES a cross-prefix state write — handler never runs', async () => {
    const { registry, ran } = makeRegistry();
    const res = await registry.callTool(
      'set_global_state',
      { namespace: 'finance', key: 'k', value: 1 },
      ctx({ runId: RUN_ID }),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Permission denied');
    expect(ran.set_global_state).toBeUndefined();
  });

  it('(b) ALLOWS an in-prefix state write — handler runs', async () => {
    const { registry, ran } = makeRegistry();
    const res = await registry.callTool(
      'set_global_state',
      { namespace: 'coder/tasks', key: 'k', value: 1 },
      ctx({ runId: RUN_ID }),
    );
    expect(res.isError).toBeFalsy();
    expect(ran.set_global_state).toBe(true);
  });

  it('DENIES a cross-prefix namespace delete', async () => {
    const { registry, ran } = makeRegistry();
    const res = await registry.callTool(
      'delete_namespace',
      { namespace: 'finance' },
      ctx({ runId: RUN_ID }),
    );
    expect(res.isError).toBe(true);
    expect(ran.delete_namespace).toBeUndefined();
  });

  it('(d) DENIES a cross-prefix knowledge add_document and ALLOWS in-prefix', async () => {
    const { registry, ran } = makeRegistry();

    const denied = await registry.callTool(
      'add_document',
      { libraryId: 'finance/q1', content: 'x' },
      ctx({ runId: RUN_ID }),
    );
    expect(denied.isError).toBe(true);
    expect(ran.add_document).toBeUndefined();

    const allowed = await registry.callTool(
      'add_document',
      { libraryId: 'coder/notes', content: 'x' },
      ctx({ runId: RUN_ID }),
    );
    expect(allowed.isError).toBeFalsy();
    expect(ran.add_document).toBe(true);
  });

  it('(c) leaves non-data tools ungated even under a profile', async () => {
    const { registry, ran } = makeRegistry();
    const res = await registry.callTool(
      'web_search',
      { query: 'anything' },
      ctx({ runId: RUN_ID }),
    );
    expect(res.isError).toBeFalsy();
    expect(ran.web_search).toBe(true);
  });
});
