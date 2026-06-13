/**
 * Denial persistence at the native-tool dispatch chokepoint.
 *
 * Proves that when the capability gate DENIES a data tool, `callTool`:
 *   - fires exactly one fire-and-forget POST to `/api/v1/permissions/denials`
 *     with the agreed contract body (no userId — webapp derives it from auth),
 *   - returns the model-readable `isError` result immediately, AND
 *   - does NOT throw even when the persistence `fetch` rejects.
 *
 * We mock the global `fetch` so no real HTTP happens, and register a run
 * context with a coder jail so a cross-prefix write is denied.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NativeToolRegistry } from '../../src/lib/tools/native-registry';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import type { CapabilityProfile } from '../../src/lib/permissions/types';

const RUN_ID = 'test-run-denial-persistence';

const coderJail: CapabilityProfile = {
  name: 'red-coder-jail',
  capabilities: [
    { resource: 'state', actions: ['read', 'write', 'create', 'delete'], selector: 'coder/*' },
  ],
};

function makeRegistry(): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  // Real data-tool NAME with a stub handler. The gate runs before the handler,
  // so on a deny the handler never runs.
  registry.register('set_global_state', {
    description: 'stub',
    inputSchema: { type: 'object' },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });
  return registry;
}

/** Build a tool context carrying the run-identity + auth fields the helper reads. */
function ctx() {
  return {
    publisher: null,
    state: {
      runId: RUN_ID,
      authToken: 'tok-abc',
      data: {
        runId: RUN_ID,
        conversationId: 'conv-1',
        options: { graphId: 'graph-1', agentId: 'agent-1' },
      },
    },
    runId: RUN_ID,
    nodeId: null,
    toolId: 't1',
    abortSignal: null,
  };
}

beforeEach(() => {
  process.env.WEBAPP_URL = 'http://webapp.test';
  runControlRegistry.register(RUN_ID, 'test-worker', { capabilityProfile: coderJail });
});

afterEach(() => {
  runControlRegistry.unregister(RUN_ID);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('denial persistence — fire-and-forget POST', () => {
  it('posts the contract body once to /api/v1/permissions/denials on deny', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const registry = makeRegistry();
    const res = await registry.callTool(
      'set_global_state',
      { namespace: 'finance', key: 'k', value: 1 },
      ctx(),
    );

    // The denial result is returned immediately, exactly as before.
    expect(res.isError).toBe(true);

    // Exactly one POST to the denials endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://webapp.test/api/v1/permissions/denials');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-abc');

    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      runId: RUN_ID,
      graphId: 'graph-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
      profileName: 'red-coder-jail',
      resource: 'state',
      action: 'write',
      address: 'finance',
      toolName: 'set_global_state',
    });
    expect(typeof body.reason).toBe('string');
    // Trust boundary: userId must NOT be in the body.
    expect('userId' in body).toBe(false);
  });

  it('does not throw out of callTool when the persistence fetch rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const registry = makeRegistry();
    const res = await registry.callTool(
      'set_global_state',
      { namespace: 'finance', key: 'k', value: 1 },
      ctx(),
    );

    // The rejected fetch is swallowed; the denial result still returns cleanly.
    expect(res.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the POST when no auth token is available (graceful skip)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const registry = makeRegistry();
    const noAuthCtx = {
      ...ctx(),
      state: { runId: RUN_ID, data: { runId: RUN_ID } }, // no authToken
    };
    const res = await registry.callTool(
      'set_global_state',
      { namespace: 'finance', key: 'k', value: 1 },
      noAuthCtx,
    );

    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
