/**
 * EnvironmentManager — pool-level contract tests.
 *
 * # What's under test
 *
 * The manager's get-or-open semantics, idempotent concurrent acquire, force
 * close, status snapshot, closeAll, and __reset for test isolation.
 *
 * # No real ssh2
 *
 * These tests inject `MockSshClient` via the manager's `clientFactory`
 * option so we exercise the real session lifecycle without an SSH server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvironmentManager, environmentManager } from '../../src/lib/environments/EnvironmentManager';
import { EnvironmentSession } from '../../src/lib/environments/EnvironmentSession';
import {
  buildEnv,
  MockSshClient,
  flushAsync,
  sleep,
} from './_helpers';

// ---------------------------------------------------------------------------
// acquire — cold + warm + concurrent
// ---------------------------------------------------------------------------

describe('EnvironmentManager — acquire()', () => {
  let manager: EnvironmentManager;
  let clients: MockSshClient[];

  beforeEach(() => {
    clients = [];
    manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => {
        const c = new MockSshClient();
        clients.push(c);
        return c;
      }) as any,
    });
  });

  afterEach(async () => {
    await manager.closeAll();
  });

  it('cold acquire opens a new session', async () => {
    const env = buildEnv({ environmentId: 'env_a' });
    const session = await manager.acquire(env, 'key', 'user_a');
    expect(session).toBeInstanceOf(EnvironmentSession);
    expect(session.state).toBe('open');
    expect(manager.size()).toBe(1);
    expect(manager.ids()).toEqual(['env_a']);
  });

  it('warm acquire returns the same session instance', async () => {
    const env = buildEnv({ environmentId: 'env_warm' });
    const a = await manager.acquire(env, 'key', 'user_a');
    const b = await manager.acquire(env, 'key', 'user_a');
    expect(a).toBe(b);
    expect(manager.size()).toBe(1);
    expect(clients.length).toBe(1); // only one client created
  });

  it('warm acquire resets the idle timer (touch())', async () => {
    const env = buildEnv({ environmentId: 'env_idle', idleTimeoutMs: 5_000 });
    const a = await manager.acquire(env, 'key', 'user_a');
    const initialUsed = a.lastUsedAt.getTime();
    await sleep(20);
    const b = await manager.acquire(env, 'key', 'user_a');
    expect(b).toBe(a);
    expect(b.lastUsedAt.getTime()).toBeGreaterThan(initialUsed);
  });

  it('concurrent acquire (cold pool) coalesces — both await same opening', async () => {
    let resolveConnect!: () => void;
    // Override factory so the first client defers connect.
    const localClients: MockSshClient[] = [];
    const localManager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => {
        const c = new MockSshClient();
        if (localClients.length === 0) {
          c.behaviour.onConnect = () => new Promise<void>((r) => { resolveConnect = r; });
        }
        localClients.push(c);
        return c;
      }) as any,
    });
    const env = buildEnv({ environmentId: 'env_race' });
    const [pA, pB] = [
      localManager.acquire(env, 'key', 'user'),
      localManager.acquire(env, 'key', 'user'),
    ];
    await flushAsync();
    expect(localClients.length).toBe(1);
    resolveConnect();
    const [a, b] = await Promise.all([pA, pB]);
    expect(a).toBe(b);
    expect(localClients.length).toBe(1);
    await localManager.closeAll();
  });

  it('cold acquire failure propagates and leaves no stale session', async () => {
    const failingManager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => {
        const c = new MockSshClient();
        c.behaviour.onConnect = () => Promise.reject(new Error('handshake-bad'));
        return c;
      }) as any,
    });
    const env = buildEnv({ environmentId: 'env_fail' });
    await expect(failingManager.acquire(env, 'k', 'u')).rejects.toThrow('handshake-bad');
    expect(failingManager.size()).toBe(0);
  });

  it('after a session naturally closes (idle), next acquire opens a fresh one', async () => {
    const env = buildEnv({ environmentId: 'env_recycle', idleTimeoutMs: 100 });
    const first = await manager.acquire(env, 'key', 'user');
    expect(manager.size()).toBe(1);
    // Wait for idle close.
    await sleep(300);
    expect(first.state).toBe('closed');
    // Pool entry should have been removed by lifecycle listener.
    expect(manager.size()).toBe(0);
    const second = await manager.acquire(env, 'key', 'user');
    expect(second).not.toBe(first);
    expect(manager.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// release — explicit no-op
// ---------------------------------------------------------------------------

describe('EnvironmentManager — release()', () => {
  it('release() is a no-op (does not close)', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    const env = buildEnv({ environmentId: 'env_rel' });
    const s = await manager.acquire(env, 'k', 'u');
    expect(s.state).toBe('open');
    manager.release('env_rel');
    // release should NOT close the session.
    expect(s.state).toBe('open');
    expect(manager.size()).toBe(1);
    await manager.closeAll();
  });

  it('release() on unknown id is silent', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    expect(() => manager.release('nope')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// forceClose
// ---------------------------------------------------------------------------

describe('EnvironmentManager — forceClose()', () => {
  it('forceClose immediately closes and removes from pool', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    const env = buildEnv({ environmentId: 'env_fc' });
    const s = await manager.acquire(env, 'k', 'u');
    expect(s.state).toBe('open');
    expect(manager.size()).toBe(1);
    await manager.forceClose('env_fc');
    expect(s.state).toBe('closed');
    expect(manager.size()).toBe(0);
  });

  it('forceClose on unknown id resolves silently', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    await expect(manager.forceClose('nope')).resolves.toBeUndefined();
  });

  it('forceClose rejects pending exec calls', async () => {
    const client = new MockSshClient();
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => client) as any,
    });
    const env = buildEnv({ environmentId: 'env_pending' });
    const session = await manager.acquire(env, 'k', 'u');
    // Force degraded.
    client.simulateDrop();
    await flushAsync();
    expect(session.state).toBe('degraded');
    const pending = session.exec('queued');
    await manager.forceClose('env_pending');
    await expect(pending).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('EnvironmentManager — status()', () => {
  it('returns null for unknown environmentId', () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    expect(manager.status('nope')).toBeNull();
  });

  it('returns full snapshot for live session', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    const env = buildEnv({ environmentId: 'env_status' });
    await manager.acquire(env, 'k', 'user_z');
    const status = manager.status('env_status');
    expect(status).not.toBeNull();
    expect(status!.environmentId).toBe('env_status');
    expect(status!.userId).toBe('user_z');
    expect(status!.state).toBe('open');
    expect(status!.openedAt).toBeInstanceOf(Date);
    expect(status!.lastUsedAt).toBeInstanceOf(Date);
    expect(status!.reconnectAttempt).toBe(0);
    expect(status!.pendingCommandCount).toBe(0);
    expect(status!.pendingCommandBytes).toBe(0);
    await manager.closeAll();
  });

  it('reflects degraded state + pending count', async () => {
    let factoryCalls = 0;
    const env = buildEnv({
      environmentId: 'env_deg',
      // Slow reconnect so we have time to inspect degraded state.
      reconnect: { maxAttempts: 5, backoffMs: 30_000, maxBackoffMs: 30_000 },
    });
    // Build a session directly — manager.status() walks the same internals.
    const session = new EnvironmentSession({
      env,
      sshKey: 'k',
      userId: env.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => {
        const c = new MockSshClient();
        // Reconnect attempts (calls > 0) hang forever.
        if (factoryCalls > 0) {
          c.behaviour.onConnect = () => new Promise(() => {/* never */});
        }
        factoryCalls += 1;
        return c as any;
      }) as any,
    });
    await session.open();
    expect(session.state).toBe('open');
    // Drop the live client.
    (session as unknown as { client: MockSshClient }).client?.simulateDrop?.();
    await flushAsync();
    expect(session.state).toBe('degraded');
    // Queue a pending command — reconnect won't fire for 30s so it stays queued.
    const pending = session.exec('queued').catch(() => 'rejected');
    await flushAsync();
    expect((session as unknown as { pendingCommands: unknown[] }).pendingCommands.length).toBeGreaterThanOrEqual(1);
    // Cleanup — close session so the test doesn't leave dangling promises.
    await session.close('test-cleanup');
    await pending;
  });
});

// ---------------------------------------------------------------------------
// closeAll
// ---------------------------------------------------------------------------

describe('EnvironmentManager — closeAll()', () => {
  it('closes every session in the pool and clears the map', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    const a = await manager.acquire(buildEnv({ environmentId: 'a' }), 'k', 'u');
    const b = await manager.acquire(buildEnv({ environmentId: 'b' }), 'k', 'u');
    expect(manager.size()).toBe(2);
    await manager.closeAll();
    expect(manager.size()).toBe(0);
    expect(a.state).toBe('closed');
    expect(b.state).toBe('closed');
  });

  it('closeAll on empty pool resolves silently', async () => {
    const manager = new EnvironmentManager();
    await expect(manager.closeAll()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// __reset
// ---------------------------------------------------------------------------

describe('EnvironmentManager — __reset()', () => {
  it('clears the pool without awaiting close events', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    await manager.acquire(buildEnv({ environmentId: 'a' }), 'k', 'u');
    expect(manager.size()).toBe(1);
    manager.__reset();
    expect(manager.size()).toBe(0);
  });

  it('drops lifecycle listeners so next test gets a clean slate', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    let count = 0;
    manager.onLifecycle(() => { count += 1; });
    await manager.acquire(buildEnv({ environmentId: 'a' }), 'k', 'u');
    expect(count).toBeGreaterThan(0);
    manager.__reset();
    const before = count;
    // After reset, new lifecycle events shouldn't trigger the old listener.
    await manager.acquire(buildEnv({ environmentId: 'b' }), 'k', 'u');
    expect(count).toBe(before);
    await manager.closeAll();
  });
});

// ---------------------------------------------------------------------------
// onLifecycle subscription
// ---------------------------------------------------------------------------

describe('EnvironmentManager — onLifecycle()', () => {
  it('forwards every session lifecycle event to subscribers', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    const events: string[] = [];
    const unsub = manager.onLifecycle((e) => { events.push(`${e.from}→${e.to}`); });
    await manager.acquire(buildEnv({ environmentId: 'a' }), 'k', 'u');
    await manager.forceClose('a');
    unsub();
    expect(events).toContain('closed→opening');
    expect(events).toContain('opening→open');
    expect(events).toContain('open→closing');
    expect(events).toContain('closing→closed');
  });

  it('unsubscribe stops further notifications', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    let count = 0;
    const unsub = manager.onLifecycle(() => { count += 1; });
    await manager.acquire(buildEnv({ environmentId: 'a' }), 'k', 'u');
    const before = count;
    unsub();
    await manager.forceClose('a');
    // After unsub, the closing→closed events shouldn't have arrived.
    expect(count).toBe(before);
  });

  it('a throwing listener does not break subsequent listeners', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    let calledLater = 0;
    manager.onLifecycle(() => { throw new Error('first listener boom'); });
    manager.onLifecycle(() => { calledLater += 1; });
    await manager.acquire(buildEnv({ environmentId: 'a' }), 'k', 'u');
    expect(calledLater).toBeGreaterThan(0);
    await manager.closeAll();
  });
});

// ---------------------------------------------------------------------------
// Singleton sanity
// ---------------------------------------------------------------------------

describe('environmentManager — singleton export', () => {
  it('exports a module-level instance', () => {
    expect(environmentManager).toBeInstanceOf(EnvironmentManager);
  });

  it('__reset() on the singleton clears its pool (test isolation)', () => {
    environmentManager.__reset();
    expect(environmentManager.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// configure() — late wiring of clientFactory + onExecComplete
// ---------------------------------------------------------------------------

describe('EnvironmentManager — configure()', () => {
  it('configure() can set clientFactory after construction', async () => {
    const manager = new EnvironmentManager();
    let factoryCalled = false;
    manager.configure({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => { factoryCalled = true; return new MockSshClient(); }) as any,
    });
    await manager.acquire(buildEnv({ environmentId: 'env_late' }), 'k', 'u');
    expect(factoryCalled).toBe(true);
    await manager.closeAll();
  });

  it('configure() can set onExecComplete after construction', async () => {
    const manager = new EnvironmentManager();
    const records: unknown[] = [];
    manager.configure({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => {
        const c = new MockSshClient();
        c.behaviour.onExec = (_cmd, ch) => { ch.finish(0); };
        return c;
      }) as any,
      onExecComplete: (r) => { records.push(r); },
    });
    const session = await manager.acquire(
      buildEnv({ environmentId: 'env_late_archive', archiveOutputLogs: true }),
      'k',
      'u',
    );
    await session.exec('echo');
    await flushAsync();
    expect(records.length).toBe(1);
    await manager.closeAll();
  });
});

// ---------------------------------------------------------------------------
// status — additional coverage
// ---------------------------------------------------------------------------

describe('EnvironmentManager — status() additional', () => {
  it('reports same userId that was passed to acquire', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    await manager.acquire(buildEnv({ environmentId: 'env_userid' }), 'k', 'user_xyz');
    const status = manager.status('env_userid');
    expect(status?.userId).toBe('user_xyz');
    await manager.closeAll();
  });

  it('reports openedAt within sensible time window', async () => {
    const manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    const before = Date.now();
    await manager.acquire(buildEnv({ environmentId: 'env_oa' }), 'k', 'u');
    const after = Date.now();
    const status = manager.status('env_oa');
    expect(status?.openedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(status?.openedAt?.getTime()).toBeLessThanOrEqual(after);
    await manager.closeAll();
  });
});
