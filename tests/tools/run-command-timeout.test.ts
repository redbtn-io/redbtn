/**
 * run_command — the omitted-timeout default.
 *
 * `run_command` used to compute `args.timeout ?? 0` and then pass
 * `timeout > 0 ? timeout : undefined` to `session.exec`, so a call with no
 * `timeout` ran with no budget of its own. That is the wrong default for a tool
 * an LLM drives: a command that never returns (an interactive prompt, a dev
 * server, a `read` on stdin) holds the pooled session's serialized op chain and
 * burns the run's whole step budget before `toolExecutor`'s 30-minute idle
 * watchdog kills the step with a generic error that names no command.
 *
 * The first fix overcorrected to 120 000 ms, turning "up to 30 minutes" into
 * "2 minutes" for `npm ci`, `docker build` and large clones. The default is now
 * 10 minutes — under the watchdog, over the slow-but-normal call — and is
 * externalised as `RUN_COMMAND_DEFAULT_TIMEOUT_MS` so it can be moved without
 * an engine publish and a worker deploy. Explicit values still win.
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

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

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
    expect(d).toContain(String(DEFAULT_TIMEOUT_MS));
    expect(d.toLowerCase()).not.toContain('default: no timeout');
    // The stale 2-minute figure must not survive in the text the model reads.
    expect(d).not.toContain('120000');
  });
});

describe('run_command — timeout default', () => {
  beforeEach(() => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
  });
  afterEach(() => vi.clearAllMocks());

  test('an omitted timeout becomes the default, not undefined', async () => {
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

  test('the default sits under the tool-step watchdog and over a two-minute build', async () => {
    // Both walls in one assertion, because the regression was crossing the
    // lower one: toolExecutor already kills a native tool step after 30 min of
    // idle (NATIVE_TOOL_IDLE_TIMEOUT_MS), so a default at or above that never
    // reports; a default at 2 min SIGKILLs `npm ci` mid-write.
    const exec = stubSession();
    await runCommandTool.handler({ command: 'npm ci' }, makeMockContext());
    const applied = execOpts(exec).timeout as number;
    expect(applied).toBeLessThan(30 * 60 * 1000);
    expect(applied).toBeGreaterThan(120_000);
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

  test('the default no longer equals DesktopAgentSession\'s old relay wait', () => {
    // 120 000 was both run_command's default AND the value the push session
    // handed requestDesktopRaw, so the two clocks fired together and a real
    // command timeout came back as `No desktop responded within 120000ms`.
    expect(DEFAULT_TIMEOUT_MS).not.toBe(120_000);
  });
});

/**
 * The env override. Read at module load, so each case needs a fresh module
 * registry — the same reason `toolExecutor`'s idle-timeout constants are not
 * re-readable at runtime either.
 */
describe('run_command — RUN_COMMAND_DEFAULT_TIMEOUT_MS', () => {
  const original = process.env.RUN_COMMAND_DEFAULT_TIMEOUT_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.RUN_COMMAND_DEFAULT_TIMEOUT_MS;
    else process.env.RUN_COMMAND_DEFAULT_TIMEOUT_MS = original;
    vi.clearAllMocks();
  });

  /** Re-import run-command with the env as currently set, and return the applied timeout. */
  async function appliedTimeoutWithEnv(value: string | undefined): Promise<number> {
    if (value === undefined) delete process.env.RUN_COMMAND_DEFAULT_TIMEOUT_MS;
    else process.env.RUN_COMMAND_DEFAULT_TIMEOUT_MS = value;
    vi.resetModules();
    const mod = await import('../../src/lib/tools/native/run-command');
    const tool = (mod as { default: typeof runCommandTool }).default;
    const { loadAndResolveEnvironment: load } =
      await import('../../src/lib/environments/loadAndResolveEnvironment');
    const { environmentManager: mgr } = await import('../../src/lib/environments/EnvironmentManager');
    vi.mocked(load).mockResolvedValue({ env: FAKE_ENV, sshKey: 'k' });
    const exec = vi.fn(async () => ({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 3, truncated: false,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(mgr.acquire).mockResolvedValue({ exec } as any);
    await tool.handler({ command: 'ls' }, makeMockContext());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (exec.mock.calls.at(-1)?.[1] as any).timeout as number;
  }

  test('a valid value overrides the built-in default', async () => {
    expect(await appliedTimeoutWithEnv('1800000')).toBe(1_800_000);
  });

  test('a non-numeric value falls back instead of becoming NaN', async () => {
    // `Number(process.env.X || fallback)` on "10m" yields NaN, and a NaN
    // timeout is not "no timeout": the underlying timer fires on the next tick
    // and every command dies instantly.
    expect(await appliedTimeoutWithEnv('10m')).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('zero and negatives fall back rather than disabling or inverting the bound', async () => {
    expect(await appliedTimeoutWithEnv('0')).toBe(DEFAULT_TIMEOUT_MS);
    expect(await appliedTimeoutWithEnv('-5000')).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('an empty string falls back', async () => {
    expect(await appliedTimeoutWithEnv('')).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('unset gives the built-in 10 minutes', async () => {
    expect(await appliedTimeoutWithEnv(undefined)).toBe(DEFAULT_TIMEOUT_MS);
  });
});
