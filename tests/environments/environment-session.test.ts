/**
 * EnvironmentSession — session-level contract tests.
 *
 * # What's under test
 *
 * Lifecycle transitions, exec / sftp behaviour, idle and max-lifetime
 * timers, openCommand / closeCommand hooks, and the archiveOutputLogs
 * callback. These are the per-session primitives the manager builds on.
 *
 * Drop tolerance + buffer overflow live in `drop-tolerance.test.ts`.
 *
 * Tests use `MockSshClient` (see `_helpers.ts`) so they exercise the
 * lifecycle state machine, timer pause/resume, and exec/sftp dispatch
 * without a real SSH server.
 */

import { describe, it, expect } from 'vitest';
import {
  EnvironmentClosedError,
  EnvironmentTimeoutError,
  EXEC_MAX_OUTPUT_BYTES,
  type EnvironmentLifecycleEvent,
  type IEnvironmentLog,
} from '../../src/lib/environments/types';
import { EnvironmentSession } from '../../src/lib/environments/EnvironmentSession';
import {
  buildSession,
  buildEnv,
  MockSshClient,
  flushAsync,
  sleep,
} from './_helpers';

// ---------------------------------------------------------------------------
// Open / close lifecycle
// ---------------------------------------------------------------------------

describe('EnvironmentSession — open() lifecycle', () => {
  it('starts in closed state', () => {
    const { session } = buildSession();
    expect(session.state).toBe('closed');
    expect(session.openedAt).toBeNull();
  });

  it('open() transitions closed → opening → open', async () => {
    const transitions: Array<{ from: string; to: string }> = [];
    const { session } = buildSession();
    session.on('lifecycle', (e: EnvironmentLifecycleEvent) => {
      transitions.push({ from: e.from, to: e.to });
    });
    await session.open();
    expect(session.state).toBe('open');
    expect(session.openedAt).toBeInstanceOf(Date);
    expect(transitions).toEqual([
      { from: 'closed', to: 'opening' },
      { from: 'opening', to: 'open' },
    ]);
  });

  it('open() is idempotent — second call resolves to same already-open state', async () => {
    const { session } = buildSession();
    await session.open();
    await session.open(); // should be a no-op
    expect(session.state).toBe('open');
  });

  it('concurrent open() calls share the same opening promise', async () => {
    const client = new MockSshClient();
    let resolveConnect!: () => void;
    const connectGate = new Promise<void>((r) => { resolveConnect = r; });
    client.behaviour.onConnect = () => connectGate;
    const { session } = buildSession({ client });

    const a = session.open();
    const b = session.open();
    // Both should be awaiting the same handshake (state=opening even before
    // the deferred connect callback runs).
    expect(session.state).toBe('opening');
    // Wait one tick so onConnect is invoked (it's deferred via setImmediate).
    await flushAsync();
    resolveConnect();
    await Promise.all([a, b]);
    expect(session.state).toBe('open');
    expect(client.connectCalls).toBe(1);
  });

  it('open() failure transitions opening → closed and rejects', async () => {
    const client = new MockSshClient();
    client.behaviour.onConnect = () => Promise.reject(new Error('handshake failed'));
    const { session } = buildSession({ client });

    await expect(session.open()).rejects.toThrow('handshake failed');
    expect(session.state).toBe('closed');
  });

  it('post-failure exec() rejects with EnvironmentClosedError', async () => {
    const client = new MockSshClient();
    client.behaviour.onConnect = () => Promise.reject(new Error('handshake failed'));
    const { session } = buildSession({ client });
    await expect(session.open()).rejects.toThrow();
    await expect(session.exec('echo')).rejects.toBeInstanceOf(EnvironmentClosedError);
  });
});

describe('EnvironmentSession — close() lifecycle', () => {
  it('close() transitions open → closing → closed', async () => {
    const transitions: Array<{ from: string; to: string }> = [];
    const { session } = buildSession();
    await session.open();
    session.on('lifecycle', (e) => transitions.push({ from: e.from, to: e.to }));
    await session.close('test');
    expect(session.state).toBe('closed');
    expect(transitions[0]).toEqual({ from: 'open', to: 'closing' });
    expect(transitions.at(-1)).toEqual({ from: 'closing', to: 'closed' });
  });

  it('close() is idempotent — second call resolves immediately', async () => {
    const { session } = buildSession();
    await session.open();
    await session.close();
    await session.close();
    expect(session.state).toBe('closed');
  });

  it('close() rejects pending exec on a degraded session', async () => {
    const { session, client } = buildSession();
    await session.open();
    // Force degraded
    (client as unknown as { emit: (e: string) => boolean }).emit('close');
    await flushAsync();
    expect(session.state).toBe('degraded');
    const pending = session.exec('echo queued');
    await session.close('test-shutdown');
    await expect(pending).rejects.toBeInstanceOf(EnvironmentClosedError);
  });

  it('close() runs closeCommand when set', async () => {
    const client = new MockSshClient();
    const seen: string[] = [];
    client.behaviour.onExec = (cmd, ch) => {
      seen.push(cmd);
      ch.pushStdout('ok');
      ch.finish(0);
    };
    const { session } = buildSession({
      env: { closeCommand: 'echo bye' },
      client,
    });
    await session.open();
    await session.close('test');
    // The command we sent should appear (with cwd prefix).
    const ran = seen.find((c) => c.includes('echo bye'));
    expect(ran).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// openCommand / closeCommand hooks
// ---------------------------------------------------------------------------

describe('EnvironmentSession — openCommand', () => {
  it('runs openCommand BEFORE flipping state to open', async () => {
    const client = new MockSshClient();
    const events: string[] = [];
    client.behaviour.onExec = (cmd, ch) => {
      events.push(`exec:${cmd}`);
      ch.pushStdout('hi');
      ch.finish(0);
    };
    const { session } = buildSession({
      env: { openCommand: 'git fetch' },
      client,
    });
    session.on('lifecycle', (e) => events.push(`lifecycle:${e.to}`));
    await session.open();
    // The exec call should have happened BEFORE the open lifecycle event.
    const execIdx = events.findIndex((e) => e.startsWith('exec:'));
    const openIdx = events.findIndex((e) => e === 'lifecycle:open');
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeGreaterThan(execIdx);
  });

  it('failed openCommand → close session and reject open()', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => {
      // Simulate the underlying stream erroring out — that's what bubbles
      // up as an exec failure. Non-zero exit alone is just a result.
      ch.fail(new Error('openCommand-failed'));
    };
    const { session } = buildSession({
      env: { openCommand: 'pre' },
      client,
    });
    await expect(session.open()).rejects.toThrow(/openCommand failed/);
    expect(session.state).toBe('closed');
  });

  it('post-failed-openCommand exec() rejects with EnvironmentClosedError', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => {
      ch.fail(new Error('boom'));
    };
    const { session } = buildSession({
      env: { openCommand: 'pre' },
      client,
    });
    await expect(session.open()).rejects.toThrow();
    await expect(session.exec('post')).rejects.toBeInstanceOf(EnvironmentClosedError);
  });
});

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe('EnvironmentSession — exec()', () => {
  it('returns stdout, stderr, exitCode, durationMs', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => {
      ch.pushStdout('out\n');
      ch.pushStderr('err\n');
      ch.finish(0);
    };
    const { session } = buildSession({ client });
    await session.open();
    const result = await session.exec('echo');
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.truncated).toBe(false);
  });

  it('truncates stdout exceeding EXEC_MAX_OUTPUT_BYTES', async () => {
    const huge = 'x'.repeat(EXEC_MAX_OUTPUT_BYTES + 1024);
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => {
      ch.pushStdout(huge);
      ch.finish(0);
    };
    const { session } = buildSession({ client });
    await session.open();
    const result = await session.exec('echo');
    expect(result.stdout.length).toBe(EXEC_MAX_OUTPUT_BYTES);
    expect(result.truncated).toBe(true);
  });

  it('truncates stderr exceeding EXEC_MAX_OUTPUT_BYTES', async () => {
    const huge = 'y'.repeat(EXEC_MAX_OUTPUT_BYTES + 4096);
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => {
      ch.pushStderr(huge);
      ch.finish(1);
    };
    const { session } = buildSession({ client });
    await session.open();
    const result = await session.exec('boom');
    expect(result.stderr.length).toBe(EXEC_MAX_OUTPUT_BYTES);
    expect(result.exitCode).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('opts.timeout fires EnvironmentTimeoutError when command runs too long', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, _ch) => {
      // Never finish — let the timeout fire.
    };
    const { session } = buildSession({ client });
    await session.open();
    await expect(session.exec('sleep', { timeout: 50 }))
      .rejects.toBeInstanceOf(EnvironmentTimeoutError);
  });

  it('opts.abortSignal aborts a running exec', async () => {
    const client = new MockSshClient();
    let chRef: ReturnType<typeof Object> | null = null;
    client.behaviour.onExec = (_cmd, ch) => {
      chRef = ch;
      // Never finish — wait for the abort.
    };
    const { session } = buildSession({ client });
    await session.open();
    const ac = new AbortController();
    const p = session.exec('sleep', { abortSignal: ac.signal });
    // Tiny delay so the exec is in flight before abort.
    await sleep(10);
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
    // Channel should have been signalled KILL.
    expect((chRef as unknown as { signalled: string }).signalled).toBe('KILL');
  });

  it('pre-aborted abortSignal short-circuits the exec', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = () => { /* never finish */ };
    const { session } = buildSession({ client });
    await session.open();
    const ac = new AbortController();
    ac.abort();
    await expect(session.exec('sleep', { abortSignal: ac.signal })).rejects.toThrow(/aborted/);
  });

  it('exec() on closed session rejects with EnvironmentClosedError', async () => {
    const { session } = buildSession();
    await session.open();
    await session.close('test');
    await expect(session.exec('echo')).rejects.toBeInstanceOf(EnvironmentClosedError);
  });

  it('exec() on never-opened session rejects with EnvironmentClosedError', async () => {
    const { session } = buildSession();
    await expect(session.exec('echo')).rejects.toBeInstanceOf(EnvironmentClosedError);
  });

  it('exec() prepends cwd to the command when env.workingDir is set', async () => {
    const client = new MockSshClient();
    let captured = '';
    client.behaviour.onExec = (cmd, ch) => {
      captured = cmd;
      ch.finish(0);
    };
    const { session } = buildSession({
      env: { workingDir: '/repo/foo' },
      client,
    });
    await session.open();
    await session.exec('ls');
    expect(captured).toContain('cd "/repo/foo"');
    expect(captured).toContain('ls');
  });

  it('exec() applies opts.cwd override over env.workingDir', async () => {
    const client = new MockSshClient();
    let captured = '';
    client.behaviour.onExec = (cmd, ch) => {
      captured = cmd;
      ch.finish(0);
    };
    const { session } = buildSession({
      env: { workingDir: '/repo/foo' },
      client,
    });
    await session.open();
    await session.exec('ls', { cwd: '/repo/bar' });
    expect(captured).toContain('cd "/repo/bar"');
    expect(captured).not.toContain('cd "/repo/foo"');
  });

  it('exec() injects opts.env exports', async () => {
    const client = new MockSshClient();
    let captured = '';
    client.behaviour.onExec = (cmd, ch) => {
      captured = cmd;
      ch.finish(0);
    };
    const { session } = buildSession({ client });
    await session.open();
    await session.exec('printenv FOO', { env: { FOO: 'bar' } });
    expect(captured).toContain('export FOO="bar"');
  });
});

// ---------------------------------------------------------------------------
// archiveOutputLogs callback
// ---------------------------------------------------------------------------

describe('EnvironmentSession — archiveOutputLogs', () => {
  it('invokes onExecComplete when archiveOutputLogs is true', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => {
      ch.pushStdout('hello');
      ch.finish(0);
    };
    const records: IEnvironmentLog[] = [];
    const { session } = buildSession({
      env: { archiveOutputLogs: true, environmentId: 'env_log_test' },
      client,
      onExecComplete: (r) => { records.push(r); },
      runId: 'run_xyz',
    });
    await session.open();
    await session.exec('echo');
    // Wait for the fire-and-forget Promise to flush.
    await flushAsync();
    expect(records.length).toBe(1);
    expect(records[0].environmentId).toBe('env_log_test');
    expect(records[0].command).toBe('echo');
    expect(records[0].runId).toBe('run_xyz');
    expect(records[0].stdout).toBe('hello');
    expect(records[0].exitCode).toBe(0);
    expect(records[0].expiresAt.getTime()).toBeGreaterThan(records[0].startedAt.getTime());
  });

  it('does NOT invoke onExecComplete when archiveOutputLogs is false', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => {
      ch.pushStdout('ok');
      ch.finish(0);
    };
    const records: IEnvironmentLog[] = [];
    const { session } = buildSession({
      env: { archiveOutputLogs: false },
      client,
      onExecComplete: (r) => { records.push(r); },
    });
    await session.open();
    await session.exec('echo');
    await flushAsync();
    expect(records.length).toBe(0);
  });

  it('onExecComplete handler failures do not break exec', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => { ch.pushStdout('x'); ch.finish(0); };
    const { session } = buildSession({
      env: { archiveOutputLogs: true },
      client,
      onExecComplete: () => { throw new Error('handler-boom'); },
    });
    await session.open();
    const result = await session.exec('echo');
    expect(result.exitCode).toBe(0);
  });

  it('emits exec_completed event on every exec, regardless of archive flag', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => { ch.pushStdout('x'); ch.finish(0); };
    const { session } = buildSession({
      env: { archiveOutputLogs: false },
      client,
    });
    const seen: number[] = [];
    session.on('exec_completed', () => { seen.push(Date.now()); });
    await session.open();
    await session.exec('a');
    await session.exec('b');
    expect(seen.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Idle timer
// ---------------------------------------------------------------------------

describe('EnvironmentSession — idle timer', () => {
  it('idle timer fires after idleTimeoutMs of no activity → graceful close', async () => {
    const { session } = buildSession({
      env: { idleTimeoutMs: 200 },
    });
    await session.open();
    expect(session.state).toBe('open');
    // Wait just before the idle timeout.
    await sleep(150);
    expect(session.state).toBe('open');
    // Cross the threshold.
    await sleep(150);
    expect(session.state).toBe('closed');
  });

  it('idle timer is reset by exec()', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => { ch.finish(0); };
    const { session } = buildSession({
      env: { idleTimeoutMs: 600 },
      client,
    });
    await session.open();
    // Burn 300ms.
    await sleep(300);
    expect(session.state).toBe('open');
    // exec resets the timer (exec itself takes ~100ms for the drain grace).
    await session.exec('echo');
    expect(session.state).toBe('open');
    // Burn 400ms — would have crossed original idle window (would be at
    // ~800ms total since open) but only ~400ms since exec returned.
    await sleep(400);
    expect(session.state).toBe('open');
    // Now fully cross the new idle window (need ~600ms post-exec).
    await sleep(300);
    expect(session.state).toBe('closed');
  }, 5_000);
});

// ---------------------------------------------------------------------------
// Max-lifetime timer
// ---------------------------------------------------------------------------

describe('EnvironmentSession — maxLifetime timer', () => {
  it('maxLifetime timer fires after maxLifetimeMs → graceful close', async () => {
    const { session } = buildSession({
      env: { idleTimeoutMs: 60_000, maxLifetimeMs: 300 },
    });
    await session.open();
    await sleep(150);
    expect(session.state).toBe('open');
    await sleep(250);
    expect(session.state).toBe('closed');
  }, 5_000);

  it('exec() does NOT reset maxLifetime timer (only idle does)', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => { ch.finish(0); };
    const { session } = buildSession({
      env: { idleTimeoutMs: 60_000, maxLifetimeMs: 300 },
      client,
    });
    await session.open();
    // Activity.
    await sleep(100);
    await session.exec('echo');
    expect(session.state).toBe('open');
    // Cross maxLifetime even though we just used.
    await sleep(300);
    expect(session.state).toBe('closed');
  }, 5_000);
});

// ---------------------------------------------------------------------------
// Timer pause/resume during degraded
// ---------------------------------------------------------------------------

describe('EnvironmentSession — idle timer pause/resume during degraded', () => {
  it('idle timer paused during degraded, resumes with remaining time on reconnect', async () => {
    let factoryCalls = 0;
    let firstClient: MockSshClient | null = null;
    let secondClient: MockSshClient | null = null;
    // First reconnect is held until we let it through, so we can stay in
    // degraded for a controllable amount of time.
    let releaseSecondConnect!: () => void;
    const secondConnectGate = new Promise<void>((r) => { releaseSecondConnect = r; });

    const env = buildEnv({
      idleTimeoutMs: 800,
      // Give the reconnect plenty of attempts so it doesn't exhaust during
      // the test window.
      reconnect: { maxAttempts: 99, backoffMs: 30, maxBackoffMs: 30 },
    });
    const session = new EnvironmentSession({
      env,
      sshKey: 'k',
      userId: env.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          firstClient = new MockSshClient();
          return firstClient as any;
        }
        if (factoryCalls === 2) {
          secondClient = new MockSshClient();
          // Block the second connect until the test releases it.
          secondClient.behaviour.onConnect = () => secondConnectGate;
          return secondClient as any;
        }
        // Anything past the second attempt — succeed instantly (shouldn't
        // matter for the test).
        const c = new MockSshClient();
        return c as any;
      }) as any,
    });
    await session.open();
    expect(session.state).toBe('open');
    // Burn 500ms of the 800ms idle window — 300ms remaining.
    await sleep(500);
    // Drop the client — flip to degraded, pause idle timer.
    firstClient!.simulateDrop();
    await flushAsync();
    expect(session.state).toBe('degraded');
    // Stay degraded for 700ms — would have crossed idle if NOT paused.
    await sleep(700);
    expect(session.state).toBe('degraded');
    // Now release the second connect — session should flip back to open.
    releaseSecondConnect();
    await sleep(80);
    expect(session.state).toBe('open');
    // We had 300ms remaining on idle. Sleep 200 — still open.
    await sleep(200);
    expect(session.state).toBe('open');
    // Cross the remaining ~100ms.
    await sleep(200);
    expect(session.state).toBe('closed');
  }, 10_000);
});

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------

describe('EnvironmentSession — SFTP', () => {
  it('sftpRead returns file content as Buffer', async () => {
    const client = new MockSshClient();
    client.sftp_.putFile('/etc/hostname', 'alphasystem\n');
    const { session } = buildSession({ client });
    await session.open();
    const buf = await session.sftpRead('/etc/hostname');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf8')).toBe('alphasystem\n');
  });

  it('sftpRead respects offset/length', async () => {
    const client = new MockSshClient();
    client.sftp_.putFile('/data/file', 'abcdefghij');
    const { session } = buildSession({ client });
    await session.open();
    const buf = await session.sftpRead('/data/file', { offset: 2, length: 4 });
    expect(buf.toString('utf8')).toBe('cdef');
  });

  it('sftpWrite writes to a temp file then renames atomically', async () => {
    const client = new MockSshClient();
    const { session } = buildSession({ client });
    await session.open();
    await session.sftpWrite('/tmp/out.txt', 'hello world');
    expect(client.sftp_.files.has('/tmp/out.txt')).toBe(true);
    expect(client.sftp_.files.get('/tmp/out.txt')!.content.toString('utf8')).toBe('hello world');
    // The temp file should not still be hanging around.
    const remainingTmps = Array.from(client.sftp_.files.keys()).filter((k) => k.includes('.tmp.'));
    expect(remainingTmps.length).toBe(0);
  });

  it('sftpWrite applies optional mode chmod after write', async () => {
    const client = new MockSshClient();
    const { session } = buildSession({ client });
    await session.open();
    await session.sftpWrite('/tmp/script.sh', '#!/bin/bash', { mode: 0o755 });
    const file = client.sftp_.files.get('/tmp/script.sh');
    expect(file?.mode).toBe(0o755);
  });

  it('sftpStat returns size, mode, modifiedAt, isDirectory', async () => {
    const client = new MockSshClient();
    client.sftp_.putFile('/etc/hostname', 'alphasystem\n', 0o644);
    const { session } = buildSession({ client });
    await session.open();
    const stat = await session.sftpStat('/etc/hostname');
    expect(stat.size).toBe(12);
    expect(stat.mode).toBe(0o644);
    expect(stat.isDirectory).toBe(false);
    expect(stat.isFile).toBe(true);
    expect(stat.modifiedAt).toBeInstanceOf(Date);
  });

  it('sftpReaddir returns name/type/size/modifiedAt for each entry', async () => {
    const client = new MockSshClient();
    client.sftp_.putDir('/etc', ['hosts', 'hostname']);
    client.sftp_.putFile('/etc/hosts', '127.0.0.1 localhost', 0o644);
    client.sftp_.putFile('/etc/hostname', 'alphasystem', 0o644);
    const { session } = buildSession({ client });
    await session.open();
    const entries = await session.sftpReaddir('/etc');
    expect(entries.length).toBe(2);
    const hostname = entries.find((e) => e.name === 'hostname');
    expect(hostname?.type).toBe('file');
    expect(hostname?.size).toBe(11);
    expect(hostname?.modifiedAt).toBeInstanceOf(Date);
  });

  it('SFTP calls on closed session reject with EnvironmentClosedError', async () => {
    const { session } = buildSession();
    await expect(session.sftpRead('/x')).rejects.toBeInstanceOf(EnvironmentClosedError);
    await expect(session.sftpWrite('/x', 'y')).rejects.toBeInstanceOf(EnvironmentClosedError);
    await expect(session.sftpStat('/x')).rejects.toBeInstanceOf(EnvironmentClosedError);
    await expect(session.sftpReaddir('/x')).rejects.toBeInstanceOf(EnvironmentClosedError);
  });

  it('sftpStat differentiates dir vs file vs link', async () => {
    const client = new MockSshClient();
    client.sftp_.putDir('/dir', []);
    client.sftp_.putFile('/file', 'content');
    const { session } = buildSession({ client });
    await session.open();
    const dirStat = await session.sftpStat('/dir');
    const fileStat = await session.sftpStat('/file');
    expect(dirStat.isDirectory).toBe(true);
    expect(dirStat.isFile).toBe(false);
    expect(fileStat.isDirectory).toBe(false);
    expect(fileStat.isFile).toBe(true);
  });

  it('sftpRead on missing path rejects', async () => {
    const { session } = buildSession();
    await session.open();
    await expect(session.sftpRead('/nonexistent')).rejects.toThrow();
  });

  it('sftpWrite cleans up tmp file on rename failure', async () => {
    const client = new MockSshClient();
    // Hijack rename to always fail.
    const origSftp = client.sftp_;
    origSftp.rename = (_from: string, _to: string, cb: (err?: Error | null) => void) => {
      cb(new Error('rename-failed'));
    };
    const { session } = buildSession({ client });
    await session.open();
    await expect(session.sftpWrite('/output', 'data')).rejects.toThrow('rename-failed');
    // Tmp file should have been unlinked.
    const tmps = Array.from(client.sftp_.files.keys()).filter((k) => k.includes('.tmp.'));
    expect(tmps.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// touch() — manual idle-timer reset
// ---------------------------------------------------------------------------

describe('EnvironmentSession — touch()', () => {
  it('updates lastUsedAt on every call', async () => {
    const { session } = buildSession();
    await session.open();
    const initial = session.lastUsedAt.getTime();
    await sleep(20);
    session.touch();
    expect(session.lastUsedAt.getTime()).toBeGreaterThan(initial);
  });

  it('touch() on a closed session is a no-op (does not reopen)', async () => {
    const { session } = buildSession();
    await session.open();
    await session.close();
    expect(session.state).toBe('closed');
    session.touch();
    expect(session.state).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// archiveOutputLogs — runId stamping + ttl
// ---------------------------------------------------------------------------

describe('EnvironmentSession — archiveOutputLogs record shape', () => {
  it('record carries runId, command, cwd, exitCode, durationMs, expiresAt', async () => {
    const client = new MockSshClient();
    client.behaviour.onExec = (_cmd, ch) => { ch.pushStdout('ok'); ch.finish(0); };
    let captured: import('../../src/lib/environments/types').IEnvironmentLog | null = null;
    const { session } = buildSession({
      env: {
        archiveOutputLogs: true,
        environmentId: 'env_archive_shape',
        workingDir: '/srv/app',
      },
      client,
      onExecComplete: (r) => { captured = r; },
      runId: 'run_42',
    });
    await session.open();
    await session.exec('ls -la');
    await flushAsync();
    expect(captured).not.toBeNull();
    expect(captured!.environmentId).toBe('env_archive_shape');
    expect(captured!.runId).toBe('run_42');
    expect(captured!.command).toBe('ls -la');
    expect(captured!.cwd).toBe('/srv/app');
    expect(captured!.exitCode).toBe(0);
    expect(captured!.durationMs).toBeGreaterThanOrEqual(0);
    expect(captured!.expiresAt.getTime()).toBeGreaterThan(captured!.startedAt.getTime());
  });
});
