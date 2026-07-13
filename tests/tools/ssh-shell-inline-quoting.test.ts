/**
 * ssh_shell inline mode — cwd/env shell-quoting regression.
 *
 * `workingDir`/`env` are LLM-controlled tool args. Both must be single-quote
 * escaped (shQuote) when interpolated into the remote command — a
 * double-quoted (or unescaped) value leaves `$(...)`/backticks live to bash.
 * Env var KEYS sit outside any quoting (`export NAME=...`), so a key that
 * isn't a valid POSIX identifier must be dropped rather than interpolated.
 *
 * Mocks the `ssh2` module directly (no real network) so we can capture the
 * EXACT command string ssh2 would hand to the remote sshd, then actually run
 * that string through real bash (mirroring what sshd does — invoke the
 * user's shell with the raw command) to prove the injection is genuinely
 * inert end-to-end, rather than fragile-matching a string that gets
 * shQuote'd TWICE (once for cwd/env, again for the outer `bash -c` PID-
 * capture wrapper — see ssh-shell.ts's `fullCommand` construction).
 *
 * This exercises the INLINE (no environmentId) code path, which builds its
 * own command string independent of EnvironmentSession (see
 * tests/environments/environment-session.test.ts for the equivalent
 * regression against the environmentId/preferred path).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factories are hoisted above the module's own top-level code, so the
// mock class must be declared via vi.hoisted() rather than a plain top-level
// class — otherwise it's a TDZ reference at hoist time. `require` (not the
// hoisted `import`) for the same reason: an ESM import binding isn't linked
// yet at hoist time, but a CJS require() resolves immediately.
const { FakeClient, getLastExecCommand, resetLastExecCommand } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  let lastExecCommand = '';

  class FakeStream extends EventEmitter {
    stderr = new EventEmitter();
    signal() { /* no-op */ }
    resume() { return this; }
  }

  class FakeClient extends EventEmitter {
    connect() {
      // Defer so handler.ts's synchronous 'ready' listener registration
      // (via conn.on('ready', ...)) has already happened.
      setImmediate(() => this.emit('ready'));
    }
    exec(command: string, _opts: unknown, cb: (err: Error | null, stream: FakeStream) => void) {
      lastExecCommand = command;
      const stream = new FakeStream();
      cb(null, stream);
      // Finish immediately with exit code 0, no output — enough for the
      // handler to settle and resolve.
      setImmediate(() => stream.emit('close', 0, null));
    }
    end() { /* no-op */ }
  }

  return {
    FakeClient,
    getLastExecCommand: () => lastExecCommand,
    resetLastExecCommand: () => { lastExecCommand = ''; },
  };
});

vi.mock('ssh2', () => ({
  Client: FakeClient,
}));

import sshShellTool from '../../src/lib/tools/native/ssh-shell';

/**
 * Run the captured command through real bash, exactly as sshd would hand it
 * to the remote shell. A nonzero exit (e.g. `cd` to a nonexistent literal
 * path — which is the CORRECT outcome for a would-be injection payload) is
 * expected and ignored; these tests assert on filesystem side effects, not
 * on the command's exit status.
 */
function runAsRemoteShellWould(command: string): void {
  spawnSync('bash', ['-c', command], { stdio: 'pipe' });
}

describe('ssh_shell inline mode — cwd/env shell-quoting', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetLastExecCommand();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-shell-quoting-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('command substitution inside workingDir is never invoked', async () => {
    const marker = path.join(tmpDir, 'pwned-cwd');
    await sshShellTool.handler(
      { host: 'localhost', user: 'alpha', command: 'true', workingDir: `${tmpDir}/$(touch ${marker})` },
      {} as any,
    );
    runAsRemoteShellWould(getLastExecCommand());
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('command substitution inside an env value is never invoked', async () => {
    const marker = path.join(tmpDir, 'pwned-env');
    await sshShellTool.handler(
      { host: 'localhost', user: 'alpha', command: 'true', env: { FOO: `$(touch ${marker})` } },
      {} as any,
    );
    runAsRemoteShellWould(getLastExecCommand());
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('an env key that is not a valid POSIX identifier is dropped, not interpolated', async () => {
    const marker = path.join(tmpDir, 'pwned-key');
    const outFile = path.join(tmpDir, 'good-out');
    await sshShellTool.handler(
      {
        host: 'localhost',
        user: 'alpha',
        command: `echo "$GOOD" > ${outFile}`,
        env: { [`FOO; touch ${marker} #`]: 'x', GOOD: 'ok' },
      },
      {} as any,
    );
    runAsRemoteShellWould(getLastExecCommand());
    // The malicious key never got interpolated into the command at all.
    expect(fs.existsSync(marker)).toBe(false);
    // The well-formed key alongside it still worked.
    expect(fs.readFileSync(outFile, 'utf8').trim()).toBe('ok');
  });
});
