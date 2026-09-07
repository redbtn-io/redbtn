/**
 * run_command — the omitted-timeout default.
 *
 * `run_command` used to compute `args.timeout ?? 0` and then pass
 * `timeout > 0 ? timeout : undefined` to `session.exec`, so a call with no
 * `timeout` ran UNBOUNDED. That is the wrong default for a tool an LLM drives:
 * a command that never returns (an interactive prompt, a dev server, a `read`
 * on stdin) pins the pooled session's serialized op chain forever and every
 * later tool call in the run queues behind it with nothing to explain why.
 * The default is now 120 000 ms; explicit values still win.
 *
 * Mocking mirrors tests/tools/ssh-run-async.test.ts: no Mongo, no redsecrets,
 * no ssh2 — the EnvironmentSession machinery has its own suite.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

vi.mock('../../src/lib/environments/loadAndResolveEnvironment', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/loadAndResolveEnvironment')>(
    '../../src/lib/environments/loadAndResolveEnvironment',
  );
  return { ...actual, loadAndResolveEnvironment: vi.fn() };
});

vi.mock('../../src/lib/environments/EnvironmentManager', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/EnvironmentManager')>(
    '../../src/lib/environments/EnvironmentManager',
  );
  return { ...actual, environmentManager: { acquire: vi.fn() } };
});

import runCommandTool from '../../src/lib/tools/native/run-command';
import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';

const DEFAULT_TIMEOUT_MS = 120_000;

const FAKE_ENV = {
  environmentId: 'env_rc',
  userId: 'user-1',
  name: 'rc env',
  kind: 'self-hosted' as const,
  host: '127.0.0.1',
  port: 22,
  user: 'tester',
  secretRef: 'KEY',
  workingDir: '/tmp',
  idleTimeoutMs: 5000,
  maxLifetimeMs: 60000,
  reconnect: { maxAttempts: 3, backoffMs: 50, maxBackoffMs: 500 },
  archiveOutputLogs: false,
  isPublic: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1', data: { environmentId: 'env_rc' } },
    runId: 'test-run',
    nodeId: 'test-node',
    toolId: 'test-tool',
    abortSignal: null,
    ...overrides,
  } as NativeToolContext;
}

/** Install a session stub and hand back the `exec` spy so tests read its opts. */
function stubSession() {
  const exec = vi.fn(async () => ({
    stdout: 'ok', stderr: '', exitCode: 0, durationMs: 3, truncated: false,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(environmentManager.acquire).mockResolvedValue({ exec } as any);
  return exec;
}

/** The `opts` object of the most recent session.exec call. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function execOpts(exec: ReturnType<typeof stubSession>): any {
  return exec.mock.calls.at(-1)?.[1];
}

describe('run_command — schema', () => {
  test('the working-directory property is `cwd` (not `workingDir`)', () => {
    // The graph-side auto-injection writes state.data.workingDir; the TOOL's own
    // argument has always been `cwd`. Renaming it would silently break callers.
    expect(runCommandTool.inputSchema.properties.cwd).toBeDefined();
    expect(runCommandTool.inputSchema.properties.workingDir).toBeUndefined();
  });

  test('the timeout description states the default instead of "no timeout"', () => {
    const d = String(runCommandTool.inputSchema.properties.timeout.description);
    expect(d).toContain('120000');
    expect(d.toLowerCase()).not.toContain('default: no timeout');
  });
});

describe('run_command — timeout default', () => {
  beforeEach(() => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
  });
  afterEach(() => vi.clearAllMocks());

  test('an omitted timeout becomes 120000, not undefined', async () => {
    const exec = stubSession();
    const r = await runCommandTool.handler({ command: 'ls' }, makeMockContext());
    expect(r.isError).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(execOpts(exec).timeout).toBe(DEFAULT_TIMEOUT_MS);
    // undefined here is what made the exec unbounded.
    expect(execOpts(exec).timeout).not.toBeUndefined();
  });

  test('an explicit null timeout is a validation error, not the default', async () => {
    // `??` only covers undefined here in practice: validation runs first and
    // `timeout !== undefined && typeof timeout !== 'number'` rejects null. A
    // model that emits `"timeout": null` gets told so rather than silently
    // inheriting a default it did not ask for.
    const exec = stubSession();
    const r = await runCommandTool.handler(
      { command: 'ls', timeout: null as unknown as number },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
    expect(exec).not.toHaveBeenCalled();
  });

  test('an explicit timeout still wins', async () => {
    const exec = stubSession();
    await runCommandTool.handler({ command: 'ls', timeout: 5_000 }, makeMockContext());
    expect(execOpts(exec).timeout).toBe(5_000);
  });

  test('an explicit timeout longer than the default is honoured', async () => {
    const exec = stubSession();
    await runCommandTool.handler({ command: 'npm run build', timeout: 900_000 }, makeMockContext());
    expect(execOpts(exec).timeout).toBe(900_000);
  });

  test('a timeout under the 100 ms floor is still rejected', async () => {
    const exec = stubSession();
    const r = await runCommandTool.handler({ command: 'ls', timeout: 50 }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
    expect(exec).not.toHaveBeenCalled();
  });

  test('cwd, env and the abort signal are still forwarded alongside the timeout', async () => {
    const exec = stubSession();
    const ac = new AbortController();
    await runCommandTool.handler(
      { command: 'ls', cwd: '/srv/app', env: { FOO: 'bar' } },
      makeMockContext({ abortSignal: ac.signal }),
    );
    const opts = execOpts(exec);
    expect(opts.cwd).toBe('/srv/app');
    expect(opts.env).toEqual({ FOO: 'bar' });
    expect(opts.abortSignal).toBe(ac.signal);
    expect(opts.timeout).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('the default applies to a push (cli) environment too', async () => {
    // The push path is where this matters most: DesktopAgentSession forwards
    // opts.timeout to the relay, so an omitted timeout used to fall through to
    // desktop-request's 12 s default rather than anything run_command chose.
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({
      env: { ...FAKE_ENV, kind: 'cli' as const, installId: 'cli-1' },
      sshKey: '',
    });
    const exec = stubSession();
    await runCommandTool.handler({ command: 'ls' }, makeMockContext());
    expect(execOpts(exec).timeout).toBe(DEFAULT_TIMEOUT_MS);
  });
});
