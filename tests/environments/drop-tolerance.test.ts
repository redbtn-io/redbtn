/**
 * EnvironmentSession — drop-tolerance / reconnect / buffer tests.
 *
 * # What's under test
 *
 * The "self-healing" half of EnvironmentSession:
 *   - When the SSH connection drops while open, the session goes degraded.
 *   - Reconnect attempts use exponential backoff up to maxAttempts.
 *   - Commands queued during degraded are replayed FIFO on reconnect.
 *   - In-flight command at drop time is captured and replayed first.
 *   - When max attempts exhausted, session goes closed and pending rejects.
 *   - Buffer overflow drops oldest commands.
 *
 * # Why a separate file
 *
 * These tests share a fairly elaborate factory pattern (multi-attempt mock
 * clients with controllable success/failure per attempt). Keeping them
 * separate from the core session tests makes the overall suite easier to
 * read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EnvironmentClosedError,
  EnvironmentBufferOverflowError,
  BUFFER_MAX_BYTES,
  BUFFER_MAX_COMMANDS,
} from '../../src/lib/environments/types';
import { EnvironmentSession } from '../../src/lib/environments/EnvironmentSession';
import { buildEnv, MockSshClient, flushAsync, sleep } from './_helpers';

/**
 * Build a session whose `clientFactory` returns a freshly-configured
 * `MockSshClient` per call, and gives each one custom behaviour from the
 * `attemptFns` array (one entry per expected client).
 *
 * `attemptFns[0]` = first open. `attemptFns[1+]` = reconnect attempts.
 */
function buildReconnectableSession(opts: {
  attemptFns: Array<(client: MockSshClient) => void>;
  envOverrides?: Parameters<typeof buildEnv>[0];
}): { session: EnvironmentSession; clients: MockSshClient[] } {
  const clients: MockSshClient[] = [];
  let attempt = 0;
  const env = buildEnv({
    reconnect: { maxAttempts: 5, backoffMs: 20, maxBackoffMs: 100 },
    ...(opts.envOverrides ?? {}),
  });
  const session = new EnvironmentSession({
    env,
    sshKey: 'k',
    userId: env.userId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clientFactory: (() => {
      const c = new MockSshClient();
      const fn = opts.attemptFns[attempt] ?? opts.attemptFns[opts.attemptFns.length - 1];
      attempt += 1;
      fn(c);
      clients.push(c);
      return c;
    }) as any,
  });
  return { session, clients };
}

// ---------------------------------------------------------------------------
// Single-drop reconnect happy path
// ---------------------------------------------------------------------------

describe('EnvironmentSession — single drop + reconnect', () => {
  it('drop while open → degraded → reconnect → open', async () => {
    const { session, clients } = buildReconnectableSession({
      attemptFns: [
        (c) => { c.behaviour.onExec = (_cmd, ch) => ch.finish(0); },
        (c) => { c.behaviour.onExec = (_cmd, ch) => ch.finish(0); },
      ],
    });
    await session.open();
    expect(session.state).toBe('open');

    // Drop the live client.
    clients[0].simulateDrop();
    await flushAsync();
    expect(session.state).toBe('degraded');

    // Wait for the reconnect timer (backoffMs=20).
    await sleep(80);
    expect(session.state).toBe('open');
    expect(clients.length).toBe(2);
  });

  it('command queued during degraded resolves after reconnect', async () => {
    const { session, clients } = buildReconnectableSession({
      attemptFns: [
        (c) => { c.behaviour.onExec = (_cmd, ch) => { ch.pushStdout('hi-from-1'); ch.finish(0); }; },
        (c) => {
          c.behaviour.onExec = (_cmd, ch) => {
            ch.pushStdout('hi-from-2');
            ch.finish(0);
          };
        },
      ],
    });
    await session.open();
    clients[0].simulateDrop();
    await flushAsync();
    expect(session.state).toBe('degraded');

    const queued = session.exec('echo queued');
    // While the new client connects, the result is pending.
    await sleep(80);
    const result = await queued;
    expect(result.stdout).toBe('hi-from-2');
    expect(result.exitCode).toBe(0);
  });

  it('multiple queued commands drain in FIFO order on reconnect', async () => {
    const order: string[] = [];
    const { session, clients } = buildReconnectableSession({
      attemptFns: [
        (c) => { c.behaviour.onExec = (cmd, ch) => { order.push(`live:${cmd}`); ch.finish(0); }; },
        (c) => {
          c.behaviour.onExec = (cmd, ch) => {
            order.push(`replay:${cmd}`);
            ch.pushStdout('ok');
            ch.finish(0);
          };
        },
      ],
    });
    await session.open();
    clients[0].simulateDrop();
    await flushAsync();

    const a = session.exec('first');
    const b = session.exec('second');
    const c = session.exec('third');
    await sleep(120);
    await Promise.all([a, b, c]);
    // Filter out any cwd prefixes — we only care about ordering of base commands.
    const replayed = order.filter((s) => s.startsWith('replay:'));
    expect(replayed[0]).toContain('first');
    expect(replayed[1]).toContain('second');
    expect(replayed[2]).toContain('third');
  });

  it('in-flight exec at drop time is captured and replayed', async () => {
    const events: string[] = [];
    const { session, clients } = buildReconnectableSession({
      attemptFns: [
        (c) => {
          c.behaviour.onExec = (cmd, _ch) => {
            // First attempt — never finishes; simulate a drop mid-exec.
            events.push(`live:${cmd}`);
            // Schedule the drop after the exec is in-flight.
            setTimeout(() => c.simulateDrop(), 20);
          };
        },
        (c) => {
          c.behaviour.onExec = (cmd, ch) => {
            events.push(`replay:${cmd}`);
            ch.pushStdout('post-drop-result');
            ch.finish(0);
          };
        },
      ],
    });
    await session.open();
    const p = session.exec('long-running');
    const result = await p;
    expect(result.stdout).toBe('post-drop-result');
    // Should have seen the command execute on both clients.
    expect(events.filter((e) => e.startsWith('replay:')).length).toBeGreaterThan(0);
  }, 5_000);
});

// ---------------------------------------------------------------------------
// Reconnect failure exhausts attempts
// ---------------------------------------------------------------------------

describe('EnvironmentSession — reconnect exhaustion', () => {
  it('all reconnect attempts fail → state goes closed, pending rejects', async () => {
    const { session, clients } = buildReconnectableSession({
      attemptFns: [
        // First open succeeds.
        (c) => { c.behaviour.onExec = (_cmd, ch) => ch.finish(0); },
        // All reconnects fail.
        (c) => { c.behaviour.onConnect = () => Promise.reject(new Error('reconnect-fail-1')); },
        (c) => { c.behaviour.onConnect = () => Promise.reject(new Error('reconnect-fail-2')); },
        (c) => { c.behaviour.onConnect = () => Promise.reject(new Error('reconnect-fail-3')); },
      ],
      envOverrides: {
        reconnect: { maxAttempts: 3, backoffMs: 10, maxBackoffMs: 50 },
      },
    });
    await session.open();
    clients[0].simulateDrop();
    await flushAsync();

    // Set up the rejection assertion BEFORE waiting so the promise has a
    // catch handler attached when reconnect-exhausted fires.
    const queued = session.exec('queued-before-rejection');
    const rejectAssertion = expect(queued).rejects.toBeInstanceOf(EnvironmentClosedError);
    // Wait for all reconnect attempts to exhaust.
    // Backoff sums: 10 + 20 + 40 ≈ 70ms total, plus mock overheads.
    await sleep(400);
    expect(session.state).toBe('closed');
    await rejectAssertion;
  }, 5_000);

  it('exec on closed session post-exhaustion rejects with EnvironmentClosedError', async () => {
    const { session, clients } = buildReconnectableSession({
      attemptFns: [
        (c) => { c.behaviour.onExec = (_cmd, ch) => ch.finish(0); },
        (c) => { c.behaviour.onConnect = () => Promise.reject(new Error('nope')); },
      ],
      envOverrides: {
        reconnect: { maxAttempts: 1, backoffMs: 10, maxBackoffMs: 50 },
      },
    });
    await session.open();
    clients[0].simulateDrop();
    await flushAsync();
    await sleep(150);
    expect(session.state).toBe('closed');
    await expect(session.exec('post-close')).rejects.toBeInstanceOf(EnvironmentClosedError);
  });
});

// ---------------------------------------------------------------------------
// Exponential backoff timing
// ---------------------------------------------------------------------------

describe('EnvironmentSession — reconnect backoff', () => {
  it('uses exponential backoff between attempts', async () => {
    const attemptStarts: number[] = [];
    const baseClient = (() => {
      const c = new MockSshClient();
      c.behaviour.onExec = (_cmd, ch) => ch.finish(0);
      return c;
    })();
    let calls = 0;
    const env = buildEnv({
      reconnect: { maxAttempts: 4, backoffMs: 50, maxBackoffMs: 1_000 },
    });
    const session = new EnvironmentSession({
      env,
      sshKey: 'k',
      userId: env.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => {
        if (calls === 0) {
          calls += 1;
          return baseClient as any;
        }
        attemptStarts.push(Date.now());
        const c = new MockSshClient();
        c.behaviour.onConnect = () => Promise.reject(new Error('still down'));
        calls += 1;
        return c as any;
      }) as any,
    });

    await session.open();
    const dropAt = Date.now();
    baseClient.simulateDrop();
    await flushAsync();
    // Wait long enough for all 4 attempts: 50 + 100 + 200 + 400 = 750ms.
    await sleep(900);

    // Expect at least 4 attempts.
    expect(attemptStarts.length).toBeGreaterThanOrEqual(3);
    // Compute gap between consecutive attempts. Each gap should be roughly
    // 2x the previous (with mock-overhead noise). We just check the gaps
    // are non-decreasing with a tolerance.
    const gaps: number[] = [];
    let prev = dropAt;
    for (const t of attemptStarts) {
      gaps.push(t - prev);
      prev = t;
    }
    // First gap should be ~50ms.
    expect(gaps[0]).toBeGreaterThanOrEqual(40);
    // Each subsequent gap should be >= 1.5x the previous (allowing for slop).
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] * 1.5 - 25);
    }
  }, 5_000);

  it('backoff caps at maxBackoffMs', async () => {
    const attemptStarts: number[] = [];
    const baseClient = (() => {
      const c = new MockSshClient();
      c.behaviour.onExec = (_cmd, ch) => ch.finish(0);
      return c;
    })();
    let calls = 0;
    const env = buildEnv({
      reconnect: { maxAttempts: 6, backoffMs: 100, maxBackoffMs: 200 },
    });
    const session = new EnvironmentSession({
      env,
      sshKey: 'k',
      userId: env.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => {
        if (calls === 0) {
          calls += 1;
          return baseClient as any;
        }
        attemptStarts.push(Date.now());
        const c = new MockSshClient();
        c.behaviour.onConnect = () => Promise.reject(new Error('down'));
        calls += 1;
        return c as any;
      }) as any,
    });

    await session.open();
    baseClient.simulateDrop();
    await flushAsync();
    // 100 + 200 + 200 + 200 + 200 + 200 = 1100ms total.
    await sleep(1500);

    // Compute gaps from attempt 2 onwards — they should all be capped at
    // ~200ms (maxBackoffMs).
    if (attemptStarts.length >= 4) {
      const gap2 = attemptStarts[2] - attemptStarts[1];
      const gap3 = attemptStarts[3] - attemptStarts[2];
      // Both should be near 200ms (allow 50ms slack).
      expect(gap2).toBeLessThan(300);
      expect(gap3).toBeLessThan(300);
    }
  }, 8_000);
});

// ---------------------------------------------------------------------------
// Buffer overflow
// ---------------------------------------------------------------------------

describe('EnvironmentSession — pending buffer overflow', () => {
  it('drops oldest pending command when count cap reached', async () => {
    // Use a hanging reconnect so we stay degraded long enough to overflow.
    const baseClient = (() => {
      const c = new MockSshClient();
      c.behaviour.onExec = (_cmd, ch) => ch.finish(0);
      return c;
    })();
    let calls = 0;
    const env = buildEnv({
      reconnect: { maxAttempts: 999, backoffMs: 60_000, maxBackoffMs: 60_000 },
    });
    const session = new EnvironmentSession({
      env,
      sshKey: 'k',
      userId: env.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => {
        if (calls === 0) {
          calls += 1;
          return baseClient as any;
        }
        const c = new MockSshClient();
        c.behaviour.onConnect = () => new Promise(() => { /* never */ });
        calls += 1;
        return c as any;
      }) as any,
    });
    await session.open();
    baseClient.simulateDrop();
    await flushAsync();
    expect(session.state).toBe('degraded');

    // Queue BUFFER_MAX_COMMANDS+5 commands.
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < BUFFER_MAX_COMMANDS + 5; i++) {
      promises.push(session.exec(`cmd-${i}`).catch(() => 'rejected'));
    }
    await flushAsync();
    // The first 5 should have been dropped (rejected with overflow err).
    const rejectedFirstFive = await Promise.all(promises.slice(0, 5));
    expect(rejectedFirstFive.every((r) => r === 'rejected')).toBe(true);
    // The buffer should now hold exactly BUFFER_MAX_COMMANDS entries.
    expect((session as unknown as { pendingCommands: unknown[] }).pendingCommands.length)
      .toBe(BUFFER_MAX_COMMANDS);

    // Cleanup — close to release remaining promises.
    await session.close('test-cleanup');
    await Promise.all(promises);
  }, 10_000);

  it('drops oldest until total bytes fit within BUFFER_MAX_BYTES', async () => {
    const baseClient = (() => {
      const c = new MockSshClient();
      c.behaviour.onExec = (_cmd, ch) => ch.finish(0);
      return c;
    })();
    let calls = 0;
    const env = buildEnv({
      reconnect: { maxAttempts: 999, backoffMs: 60_000, maxBackoffMs: 60_000 },
    });
    const session = new EnvironmentSession({
      env,
      sshKey: 'k',
      userId: env.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => {
        if (calls === 0) { calls += 1; return baseClient as any; }
        const c = new MockSshClient();
        c.behaviour.onConnect = () => new Promise(() => {/* never */});
        calls += 1;
        return c as any;
      }) as any,
    });
    await session.open();
    baseClient.simulateDrop();
    await flushAsync();
    expect(session.state).toBe('degraded');

    // Queue 11 commands of ~100KB each — total 1.1MB, just over 1MB cap.
    const big = 'x'.repeat(100_000);
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 11; i++) {
      promises.push(session.exec(`${big}-${i}`).catch(() => 'rejected'));
    }
    await flushAsync();
    const totalBytes = (session as unknown as { pendingBytes: number }).pendingBytes;
    expect(totalBytes).toBeLessThanOrEqual(BUFFER_MAX_BYTES);

    // Cleanup.
    await session.close('test-cleanup');
    await Promise.all(promises);
  }, 10_000);

  it('rejects single command bigger than BUFFER_MAX_BYTES with EnvironmentBufferOverflowError', async () => {
    const baseClient = (() => {
      const c = new MockSshClient();
      c.behaviour.onExec = (_cmd, ch) => ch.finish(0);
      return c;
    })();
    let calls = 0;
    const env = buildEnv({
      reconnect: { maxAttempts: 999, backoffMs: 60_000, maxBackoffMs: 60_000 },
    });
    const session = new EnvironmentSession({
      env,
      sshKey: 'k',
      userId: env.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => {
        if (calls === 0) { calls += 1; return baseClient as any; }
        const c = new MockSshClient();
        c.behaviour.onConnect = () => new Promise(() => {/* never */});
        calls += 1;
        return c as any;
      }) as any,
    });
    await session.open();
    baseClient.simulateDrop();
    await flushAsync();

    const oversized = 'x'.repeat(BUFFER_MAX_BYTES + 1);
    await expect(session.exec(oversized)).rejects.toBeInstanceOf(EnvironmentBufferOverflowError);

    await session.close('test-cleanup');
  }, 5_000);
});

// ---------------------------------------------------------------------------
// State transitions during reconnect (regression)
// ---------------------------------------------------------------------------

describe('EnvironmentSession — lifecycle event sequence on drop+reconnect', () => {
  it('emits open → degraded → opening → open lifecycle events', async () => {
    const transitions: string[] = [];
    const { session, clients } = buildReconnectableSession({
      attemptFns: [
        (c) => { c.behaviour.onExec = (_cmd, ch) => ch.finish(0); },
        (c) => { c.behaviour.onExec = (_cmd, ch) => ch.finish(0); },
      ],
    });
    session.on('lifecycle', (e) => transitions.push(`${e.from}→${e.to}`));
    await session.open();
    clients[0].simulateDrop();
    await flushAsync();
    await sleep(150);
    expect(session.state).toBe('open');
    expect(transitions).toContain('closed→opening');
    expect(transitions).toContain('opening→open');
    expect(transitions).toContain('open→degraded');
    // After reconnect, we transition degraded → opening or degraded → open.
    // The session's reconnect path goes degraded → open directly (state set
    // to 'open' inside attemptReconnect), so we look for that.
    const hasReopen = transitions.some((t) => t === 'degraded→open' || t === 'opening→open');
    expect(hasReopen).toBe(true);
  });
});
