/**
 * ssh_shell with `environmentId` — integration tests.
 *
 * # What's under test
 *
 * Confirms the Phase B routing: when `environmentId` is provided, the tool
 * acquires an `EnvironmentSession` via the manager (NOT the inline ssh2
 * code path). Verifies pooling: a second call with the same env reuses the
 * same session (no fresh handshake = same MockSshClient instance).
 *
 * # No real ssh2
 *
 * We swap in `MockSshClient` via the manager's `clientFactory`. The mock
 * auto-becomes-ready on connect() and exec() defaults to exit-0/empty by
 * default — tests configure `onExec` to push specific output. We stub
 * `loadAndResolveEnvironment` so the tests don't need Mongo or redsecrets.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';
import { buildEnv, MockSshClient, MockSshChannel } from './_helpers';

// Stub the helper module — every test sets its own findEnvironment +
// secretsResolver via this mock so we don't touch Mongo or redsecrets.
vi.mock('../../src/lib/environments/loadAndResolveEnvironment', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/loadAndResolveEnvironment')>(
    '../../src/lib/environments/loadAndResolveEnvironment',
  );
  return {
    ...actual,
    loadAndResolveEnvironment: vi.fn(),
  };
});

import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import sshShellTool from '../../src/lib/tools/native/ssh-shell';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockContext {
  publisher: { publish: (e: unknown) => void } | null;
  state: Record<string, unknown>;
  runId: string | null;
  nodeId: string | null;
  toolId: string | null;
  abortSignal: AbortSignal | null;
}

function buildContext(userId: string, overrides: Partial<MockContext> = {}): MockContext {
  return {
    publisher: { publish: () => { /* noop */ } },
    state: { userId },
    runId: 'run_test',
    nodeId: 'node_test',
    toolId: 'tool_test',
    abortSignal: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ssh_shell — environmentId mode', () => {
  let clients: MockSshClient[];

  beforeEach(() => {
    // Reset the singleton between tests — Phase A's __reset() is the safe path.
    environmentManager.__reset();
    // Wire the singleton's clientFactory to produce mocks.
    clients = [];
    environmentManager.configure({
      clientFactory: (() => {
        const c = new MockSshClient();
        // By default, exec() returns "ok" stdout exit-0 — tests can
        // override per-client via c.behaviour.onExec.
        c.behaviour.onExec = (command: string, channel: MockSshChannel) => {
          // Mirror the command back so tests can confirm what got executed.
          channel.pushStdout(`ran: ${command}`);
          setImmediate(() => channel.finish(0));
        };
        clients.push(c);
        return c;
      }) as unknown as Parameters<typeof environmentManager.configure>[0]['clientFactory'],
    });
  });

  afterEach(async () => {
    await environmentManager.closeAll();
    vi.clearAllMocks();
  });

  it('routes through EnvironmentManager when environmentId is provided', async () => {
    const env = buildEnv({ environmentId: 'env_pool', userId: 'user_a' });
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({
      env,
      sshKey: '-----PRIVATE KEY-----',
    });

    const result = await sshShellTool.handler(
      { environmentId: 'env_pool', command: 'echo hello' },
      buildContext('user_a') as never,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.environmentId).toBe('env_pool');
    // The mock's onExec wraps command in `cd ... && echo hello` because the
    // env has workingDir=/tmp by default — verify we see something derived.
    expect(parsed.stdout).toMatch(/ran: cd .+ echo hello/);
    // Confirm the resolution helper was called with the right inputs.
    expect(loadAndResolveEnvironment).toHaveBeenCalledWith('env_pool', 'user_a');
    // Exactly one client constructed for this single call.
    expect(clients.length).toBe(1);
    expect(clients[0].connectCalls).toBe(1);
    expect(clients[0].execCalls.length).toBe(1);
  });

  it('reuses the same session across two consecutive calls (pooling — no second handshake)', async () => {
    const env = buildEnv({ environmentId: 'env_pool', userId: 'user_a' });
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({
      env,
      sshKey: 'k',
    });

    const r1 = await sshShellTool.handler(
      { environmentId: 'env_pool', command: 'echo one' },
      buildContext('user_a') as never,
    );
    expect(JSON.parse(r1.content[0].text).success).toBe(true);

    const r2 = await sshShellTool.handler(
      { environmentId: 'env_pool', command: 'echo two' },
      buildContext('user_a') as never,
    );
    expect(JSON.parse(r2.content[0].text).success).toBe(true);

    // CRITICAL: only ONE client/session was constructed across both calls.
    // Pooling eliminates the second SSH handshake.
    expect(clients.length).toBe(1);
    expect(clients[0].connectCalls).toBe(1);
    expect(clients[0].execCalls.length).toBe(2);
    expect(clients[0].execCalls[0]).toContain('echo one');
    expect(clients[0].execCalls[1]).toContain('echo two');
  });

  it('returns a clean tool error when state.userId is empty', async () => {
    const result = await sshShellTool.handler(
      { environmentId: 'env_pool', command: 'echo x' },
      buildContext('' as string) as never, // empty userId
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/userId/);
    // Resolution helper should NEVER have been called when userId is missing.
    expect(loadAndResolveEnvironment).not.toHaveBeenCalled();
  });

  it('surfaces resolution errors from the helper as tool errors', async () => {
    vi.mocked(loadAndResolveEnvironment).mockRejectedValue(
      Object.assign(new Error('Environment not found: env_xxx'), { code: 'ENV_NOT_FOUND' }),
    );

    const result = await sshShellTool.handler(
      { environmentId: 'env_xxx', command: 'echo x' },
      buildContext('user_a') as never,
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe('ENV_NOT_FOUND');
    expect(parsed.error).toMatch(/Environment not found/);
  });

  it('returns clean error when environmentId is omitted AND host is missing (no auto-fallback)', async () => {
    // Inline mode requires host — without it we surface a friendly error
    // rather than crashing.
    const result = await sshShellTool.handler(
      { command: 'echo x' },
      buildContext('user_a') as never,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/either `environmentId`.*or inline `host`/);
    // The resolution helper must NOT have been called for inline mode.
    expect(loadAndResolveEnvironment).not.toHaveBeenCalled();
  });

  it('respects state.data.userId when state.userId is missing (defensive fallback)', async () => {
    const env = buildEnv({ environmentId: 'env_pool', userId: 'user_a' });
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env, sshKey: 'k' });

    const result = await sshShellTool.handler(
      { environmentId: 'env_pool', command: 'echo x' },
      // userId NOT at root — only nested under data
      {
        publisher: null,
        state: { data: { userId: 'user_a' } },
        runId: null,
        nodeId: null,
        toolId: null,
        abortSignal: null,
      } as never,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).success).toBe(true);
    expect(loadAndResolveEnvironment).toHaveBeenCalledWith('env_pool', 'user_a');
  });
});
