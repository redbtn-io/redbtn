/**
 * `status()` against a push session.
 *
 * The snapshot read `pendingCommands.length` and `pendingBytes` straight off
 * the concrete session. Those belong to `EnvironmentSession`'s reconnect
 * buffer; a `DesktopAgentSession` (desktop-agent / cli connector) has no socket
 * to drop and therefore neither field, so every status call for a desktop or
 * workspace environment died with
 *
 *   TypeError: Cannot read properties of undefined (reading 'length')
 *
 * Inside a lifecycle listener `emitLifecycle`'s try/catch swallowed it, which
 * is why it only ever showed up as a line in the worker log.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EnvironmentManager } from '../../src/lib/environments/EnvironmentManager';
import { buildEnv, MockSshClient } from './_helpers';

let manager: EnvironmentManager | null = null;

afterEach(async () => {
  await manager?.closeAll().catch(() => {});
  manager = null;
});

describe('EnvironmentManager.status() — push vs SSH sessions', () => {
  it.each(['cli', 'desktop-agent'] as const)(
    'returns a full snapshot with zeroed buffer counters for a %s (push) session',
    async (kind) => {
      manager = new EnvironmentManager({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clientFactory: (() => new MockSshClient()) as any,
      });
      const env = buildEnv({ environmentId: `env_push_${kind}`, kind, installId: 'inst_1' });

      // A push session opens without a socket, so this never touches ssh2.
      await manager.acquire(env, '', 'user_push');

      // The call must not throw — that is the bug — and must answer with the
      // only honest value for a session that has no reconnect buffer.
      const status = manager.status(`env_push_${kind}`);
      expect(status).not.toBeNull();
      expect(status!.environmentId).toBe(`env_push_${kind}`);
      expect(status!.userId).toBe('user_push');
      expect(status!.state).toBe('open');
      expect(status!.pendingCommandCount).toBe(0);
      expect(status!.pendingCommandBytes).toBe(0);
    }
  );

  it('still reports the real buffer counts for an SSH-shaped session', async () => {
    manager = new EnvironmentManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: (() => new MockSshClient()) as any,
    });
    await manager.acquire(buildEnv({ environmentId: 'env_ssh' }), 'k', 'user_ssh');

    // Reach into the pool the same way status() does and plant a buffer, so the
    // guard is shown to pass real numbers through rather than flattening them.
    const session = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get('env_ssh') as {
      pendingCommands: unknown[];
      pendingBytes: number;
    };
    session.pendingCommands.push({ bytes: 40 }, { bytes: 60 });
    session.pendingBytes = 100;

    const status = manager.status('env_ssh');
    expect(status!.pendingCommandCount).toBe(2);
    expect(status!.pendingCommandBytes).toBe(100);
  });
});
