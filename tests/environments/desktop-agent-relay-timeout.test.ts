/**
 * Push-session relay timeout — regression guard for the 12-second cliff.
 *
 * `EnvironmentManager.acquire` builds a `DesktopAgentSession` for every
 * `desktop-agent`/`cli` environment. That constructor's FOURTH parameter is a
 * POSITIONAL `timeoutMs: number` — not an options object — and the manager used
 * to omit it entirely. With it undefined every relay op fell through to
 * `desktop-request`'s `DEFAULT_TIMEOUT_MS` of 12 000, so a `run_command`,
 * `read_file` or `ssh_copy` against a `cli` connector that took longer than 12 s
 * failed with `No desktop responded within 12000ms` while the command kept
 * running on the far side.
 *
 * These tests assert the value that actually reaches the wire, because that is
 * the thing that broke: a wrong-shaped 4th argument (an object) would still
 * construct fine but would never produce a number here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const raw = vi.fn();
vi.mock('../../src/lib/tools/native/desktop-request', () => ({
  requestDesktopRaw: (...a: unknown[]) => raw(...a),
}));

import {
  EnvironmentManager,
  DESKTOP_RELAY_MIN_TIMEOUT_MS,
} from '../../src/lib/environments/EnvironmentManager';
import { DesktopAgentSession } from '../../src/lib/environments/DesktopAgentSession';
import type { IEnvironment } from '../../src/lib/environments/types';
import { buildEnv } from './_helpers';

function pushEnv(overrides: Partial<IEnvironment> = {}): IEnvironment {
  return buildEnv({
    environmentId: 'env_push',
    kind: 'cli',
    installId: 'cli-install-1',
    ...overrides,
  });
}

/** The `timeoutMs` of the most recent relay round-trip. */
function lastRelayTimeout(): unknown {
  const call = raw.mock.calls.at(-1);
  return (call?.[0] as { timeoutMs?: unknown } | undefined)?.timeoutMs;
}

describe('EnvironmentManager → DesktopAgentSession relay timeout', () => {
  let manager: EnvironmentManager;

  beforeEach(() => {
    raw.mockReset();
    raw.mockResolvedValue({ ok: true, result: { stdout: '', stderr: '', exitCode: 0, durationMs: 1 } });
    manager = new EnvironmentManager();
  });

  afterEach(async () => {
    await manager.closeAll();
  });

  it('the floor is five minutes, not the 12 s desktop-request default', () => {
    expect(DESKTOP_RELAY_MIN_TIMEOUT_MS).toBe(300_000);
  });

  it('a cli env gets a DesktopAgentSession, not an SSH session', async () => {
    const session = await manager.acquire(pushEnv(), '', 'user_a');
    expect(session).toBeInstanceOf(DesktopAgentSession);
  });

  it('exec carries the floor when idleTimeoutMs is below it', async () => {
    // buildEnv's default idleTimeoutMs is 5_000 — well under the floor.
    const session = await manager.acquire(pushEnv({ idleTimeoutMs: 5_000 }), '', 'user_a');
    await session.exec('echo hi');
    expect(lastRelayTimeout()).toBe(300_000);
  });

  it('never leaves the relay timeout undefined (the 12 s fall-through)', async () => {
    // A doc loaded from Mongo before the field existed has no idleTimeoutMs at all.
    const env = pushEnv({ environmentId: 'env_push_nofield' });
    delete (env as Partial<IEnvironment>).idleTimeoutMs;
    const session = await manager.acquire(env, '', 'user_a');
    await session.exec('echo hi');
    expect(lastRelayTimeout()).toBe(300_000);
    expect(lastRelayTimeout()).not.toBeUndefined();
  });

  it('a longer idleTimeoutMs wins over the floor', async () => {
    const session = await manager.acquire(
      pushEnv({ environmentId: 'env_push_long', idleTimeoutMs: 900_000 }),
      '',
      'user_a',
    );
    await session.exec('echo hi');
    expect(lastRelayTimeout()).toBe(900_000);
  });

  it('applies to desktop-agent environments too, not just cli', async () => {
    const session = await manager.acquire(
      pushEnv({ environmentId: 'env_push_da', kind: 'desktop-agent' }),
      '',
      'user_a',
    );
    await session.exec('echo hi');
    expect(lastRelayTimeout()).toBe(300_000);
  });

  it('an explicit per-call timeout still wins', async () => {
    const session = await manager.acquire(pushEnv({ environmentId: 'env_push_opt' }), '', 'user_a');
    await session.exec('echo hi', { timeout: 30_000 });
    expect(lastRelayTimeout()).toBe(30_000);
  });

  it('sftp ops get the session timeout as well (relay() path)', async () => {
    raw.mockResolvedValue({ ok: true, result: { contentB64: Buffer.from('x').toString('base64') } });
    const session = await manager.acquire(pushEnv({ environmentId: 'env_push_sftp' }), '', 'user_a');
    await session.sftpRead('/tmp/x');
    expect(lastRelayTimeout()).toBe(300_000);
  });
});

describe('DesktopAgentSession — the 4th constructor argument is positional', () => {
  beforeEach(() => {
    raw.mockReset();
    raw.mockResolvedValue({ ok: true, result: { stdout: '', stderr: '', exitCode: 0, durationMs: 1 } });
  });

  it('a positional number reaches the wire', async () => {
    const s = new DesktopAgentSession(pushEnv(), 'user_a', 'cli-install-1', 300_000);
    await s.exec('echo hi');
    expect(lastRelayTimeout()).toBe(300_000);
  });

  it('omitting it is what produced the 12 s fall-through', async () => {
    const s = new DesktopAgentSession(pushEnv(), 'user_a', 'cli-install-1');
    await s.exec('echo hi');
    // undefined here is precisely what makes desktop-request apply its own
    // DEFAULT_TIMEOUT_MS (12 000). The manager must never construct this way.
    expect(lastRelayTimeout()).toBeUndefined();
  });
});
