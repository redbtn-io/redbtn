/**
 * Regression test: invoke_tool MUST dispatch through NativeToolRegistry.callTool()
 * — the single chokepoint that enforces the capability profile gate and the
 * exec-guard (kill switch / rate limit / audit) — not through a raw
 * `tool.handler()` call. The bug: invoke-tool.ts used to do
 * `getNativeRegistry().get(toolName)` + `tool.handler(args, context)`
 * directly, which skipped `enforceToolCapability` entirely. Any graph wired
 * with `invoke_tool` could reach `run_command`/`ssh_shell`/etc. with a jailed
 * (or even completely unprofiled, fail-closed) run's capability profile fully
 * unenforced.
 *
 * Uses the REAL native-tool singleton + the REAL invoke_tool handler (no
 * mocking of native-registry) so this exercises the actual dispatch path,
 * mirroring tests/permissions/callTool-gate.test.ts's approach. `run_command`
 * (a real DATA_TOOL_RULES entry, resource: 'exec', fail-closed) is stubbed
 * for the duration of the test so no real SSH session is touched — the gate
 * runs BEFORE the handler, so the stub only fires if the call was allowed.
 *
 * A capability ALLOW still has to clear the exec-guard runtime gates (kill
 * switch / rate limit / durable audit — see tests/permissions/exec-guard.test.ts)
 * before the handler runs, so this file injects a fake redis client and stubs
 * `fetch` the same way that suite does, purely so the "allowed" case doesn't
 * hang on real infra. The gate logic itself is exec-guard's, not this file's,
 * concern.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import invokeToolTool from '../../src/lib/tools/native/invoke-tool';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import { __setRedisForTest } from '../../src/lib/permissions/exec-guard';
import type { CapabilityProfile } from '../../src/lib/permissions/types';

const RUN_ID = 'test-run-invoke-tool-gate';
const ALLOWED_ENV = 'env_ALLOWED';
const OTHER_ENV = 'env_OTHER';

const execScoped: CapabilityProfile = {
  name: 'exec-scoped',
  capabilities: [{ resource: 'exec', actions: ['execute'], selector: ALLOWED_ENV }],
};

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

const fakeRedis = {
  get: vi.fn(async (_k: string): Promise<string | null> => null),
  incr: vi.fn(async (_k: string): Promise<number> => 1),
  expire: vi.fn(async (_k: string, _s: number): Promise<number> => 1),
};

describe('invoke_tool — dispatches through the real capability gate', () => {
  const registry = getNativeRegistry();
  let originalRunCommand: ReturnType<typeof registry.get>;
  let ran = false;

  beforeEach(() => {
    originalRunCommand = registry.get('run_command');
    ran = false;
    registry.register('run_command', {
      description: 'stub for invoke_tool gate test',
      inputSchema: { type: 'object' },
      handler: async () => {
        ran = true;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    // Exec-guard runtime gates (kill switch/rate-limit/audit) run AFTER the
    // capability check, before the handler — stub their infra so an ALLOW
    // resolves instead of hanging on a real redis/webapp connection.
    fakeRedis.get.mockImplementation(async () => null);
    fakeRedis.incr.mockImplementation(async () => 1);
    fakeRedis.expire.mockImplementation(async () => 1);
    __setRedisForTest(fakeRedis);
    process.env.WEBAPP_URL = 'http://localhost:3000';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as Response));
  });

  afterEach(() => {
    if (originalRunCommand) registry.register('run_command', originalRunCommand);
    runControlRegistry.unregister(RUN_ID);
    __setRedisForTest(null);
    vi.unstubAllGlobals();
  });

  it('DENIES invoke_tool(run_command) on an unprofiled run (exec is fail-closed)', async () => {
    runControlRegistry.register(RUN_ID, 'test-worker'); // no capabilityProfile
    const result = await invokeToolTool.handler(
      { toolName: 'run_command', args: { command: 'ls', environmentId: ALLOWED_ENV } },
      ctx({ runId: RUN_ID }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/permission denied/i);
    expect(ran).toBe(false);
  });

  it('DENIES invoke_tool(run_command) on an environmentId the profile does not grant', async () => {
    runControlRegistry.register(RUN_ID, 'test-worker', { capabilityProfile: execScoped });
    const result = await invokeToolTool.handler(
      { toolName: 'run_command', args: { command: 'ls', environmentId: OTHER_ENV } },
      ctx({ runId: RUN_ID }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/permission denied/i);
    expect(ran).toBe(false);
  });

  it('ALLOWS invoke_tool(run_command) on the granted environmentId', async () => {
    runControlRegistry.register(RUN_ID, 'test-worker', { capabilityProfile: execScoped });
    const result = await invokeToolTool.handler(
      { toolName: 'run_command', args: { command: 'ls', environmentId: ALLOWED_ENV } },
      // authToken so exec-guard's durable-audit POST can authenticate — a
      // capability ALLOW that then fails the fail-closed audit check would
      // still surface as a deny, which isn't what this test is exercising.
      ctx({ runId: RUN_ID, authToken: 'tok', userId: 'u1' }),
    );
    expect(result.isError).toBeFalsy();
    expect(ran).toBe(true);
  });
});
