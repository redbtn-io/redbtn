/**
 * Push sessions fail fast on an offline connector — the 2026-09-15 regression.
 *
 * The hub was redeployed under a workspace runner; the runner's `redbtn connect`
 * WebSocket hung mid-handshake and never re-registered. The engine kept
 * dispatching at that environment and each tool call waited the FULL relay
 * timeout — `No desktop responded within 630000ms`, three times, 27 minutes of a
 * 40-minute run — against a connector whose presence key had expired 70 s in.
 *
 * So the assertions here are about TIME and about the CODE, not just the
 * message: a verdict of offline must short-circuit the wait, and it must arrive
 * as `ENV_OFFLINE` rather than the `desktop_failed` every relay timeout already
 * produces, because those two mean opposite things to the agent reading them
 * ("blocked, stop" vs "slow, maybe retry").
 *
 * The mid-flight case is the one the pre-flight check alone cannot cover: the
 * connector was live when the op started and died while it waited.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const raw = vi.fn();
vi.mock('../../src/lib/tools/native/desktop-request', () => ({
  requestDesktopRaw: (...a: unknown[]) => raw(...a),
}));

const probe = vi.fn();
vi.mock('../../src/lib/environments/desktop-presence', () => ({
  probeDesktopPresence: (...a: unknown[]) => probe(...a),
}));

import {
  DesktopAgentSession,
  ENV_OFFLINE,
  LIVENESS_POLL_MS,
  offlineMessage,
} from '../../src/lib/environments/DesktopAgentSession';
import type { IEnvironment } from '../../src/lib/environments/types';
import { buildEnv } from './_helpers';

const LAST_SEEN = new Date('2026-09-15T06:53:51.000Z');

function pushEnv(overrides: Partial<IEnvironment> = {}): IEnvironment {
  return buildEnv({
    environmentId: 'env_runner',
    kind: 'cli',
    userId: 'user_1',
    installId: 'cli-abc',
    lastSeenAt: LAST_SEEN,
    ...overrides,
  });
}

function session(env: IEnvironment = pushEnv()): DesktopAgentSession {
  return new DesktopAgentSession(env, 'user_1', env.installId ?? '', 600_000);
}

const online = { verdict: 'online' as const, source: 'redis' as const };
const unknown = { verdict: 'unknown' as const, source: 'unavailable' as const };
const offline = { verdict: 'offline' as const, offlineForSeconds: 132, source: 'redis' as const };

beforeEach(() => {
  raw.mockReset();
  probe.mockReset();
  probe.mockResolvedValue(online);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DesktopAgentSession — offline environments', () => {
  it('refuses an exec against an offline connector instead of dispatching it', async () => {
    probe.mockResolvedValue(offline);
    raw.mockImplementation(() => new Promise(() => { /* would hang for 630 s */ }));

    await expect(session().exec('ls')).rejects.toMatchObject({
      name: 'DesktopAgentError',
      code: ENV_OFFLINE,
    });
    // The whole point: nothing was published, so nothing can wait on a reply.
    expect(raw).not.toHaveBeenCalled();
  });

  it('names the environment and how long it has been gone', async () => {
    probe.mockResolvedValue(offline);
    await expect(session().exec('ls')).rejects.toThrow(
      'Environment env_runner is offline (no presence for 132 s); the runner may have lost its hub session',
    );
    expect(offlineMessage('env_runner', 132)).toContain('env_runner');
  });

  it('probes with the userId + installId the gateway keys presence on, and the doc lastSeenAt', async () => {
    probe.mockResolvedValue(offline);
    await expect(session().exec('ls')).rejects.toThrow();
    expect(probe).toHaveBeenCalledWith({
      userId: 'user_1',
      installId: 'cli-abc',
      lastSeenAt: LAST_SEEN,
    });
  });

  it('an online environment proceeds exactly as before', async () => {
    raw.mockResolvedValue({ ok: true, result: { stdout: 'hi', stderr: '', exitCode: 0, durationMs: 4, truncated: false } });
    const r = await session().exec('ls', { cwd: '/tmp' });
    expect(r.stdout).toBe('hi');
    expect(raw).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1', installId: 'cli-abc', kind: 'exec' }),
    );
  });

  it('a probe that cannot reach a verdict never fails a healthy run', async () => {
    probe.mockResolvedValue(unknown);
    raw.mockResolvedValue({ ok: true, result: { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, truncated: false } });
    const r = await session().exec('ls');
    expect(r.stdout).toBe('ok');
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('a probe that rejects is not allowed to become the op failure', async () => {
    probe.mockRejectedValueOnce(new Error('redis exploded'));
    raw.mockResolvedValue({ ok: true, result: { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, truncated: false } });
    // probeDesktopPresence is documented never to throw; if it ever does, that
    // must surface as itself and not be mistaken for an offline verdict.
    await expect(session().exec('ls')).rejects.toThrow('redis exploded');
    expect(raw).not.toHaveBeenCalled();
  });

  it('a connector that dies MID-op is caught within one poll interval, not at the relay timeout', async () => {
    vi.useFakeTimers();
    // Live at dispatch, gone by the first in-flight poll — the redeploy case.
    probe.mockResolvedValueOnce(online).mockResolvedValue(offline);
    raw.mockImplementation(() => new Promise(() => { /* the 630 s wait */ }));

    const pending = session().exec('sleep 600');
    const assertion = expect(pending).rejects.toMatchObject({ code: ENV_OFFLINE });

    await vi.advanceTimersByTimeAsync(LIVENESS_POLL_MS + 10);
    await assertion;
    // It never reached the relay's own timeout.
    expect(LIVENESS_POLL_MS).toBeLessThan(630_000);
  });

  it('an op that finishes before the first poll settles normally, poller cleaned up', async () => {
    vi.useFakeTimers();
    raw.mockResolvedValue({ ok: true, result: { stdout: 'fast', stderr: '', exitCode: 0, durationMs: 2, truncated: false } });
    const r = await session().exec('echo fast');
    expect(r.stdout).toBe('fast');
    // Pre-flight only: the interval was cleared before it could ever fire.
    probe.mockResolvedValue(offline);
    await vi.advanceTimersByTimeAsync(LIVENESS_POLL_MS * 3);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('guards sftp too, not just exec', async () => {
    probe.mockResolvedValue(offline);
    await expect(session().sftpRead('/etc/hostname')).rejects.toMatchObject({ code: ENV_OFFLINE });
    expect(raw).not.toHaveBeenCalled();
  });

  it('an env with no installId cannot be probed, so it behaves as before', async () => {
    probe.mockResolvedValue(unknown);
    raw.mockResolvedValue({ ok: true, result: { stdout: '', stderr: '', exitCode: 0, durationMs: 1, truncated: false } });
    const s = new DesktopAgentSession(pushEnv({ installId: undefined }), 'user_1', '', 600_000);
    await expect(s.exec('ls')).resolves.toBeTruthy();
  });
});
