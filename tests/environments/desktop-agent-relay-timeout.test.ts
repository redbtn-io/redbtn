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
 *
 * Round 2 adds the two bounds the first pass missed:
 *   - the relay wait and the connector's command budget are separate clocks and
 *     must never be equal (`RELAY_GRACE_MS`), or a plain command timeout comes
 *     back as the presence error `No desktop responded within Nms`;
 *   - `idleTimeoutMs` comes out of Mongo unclamped, so the derived relay wait
 *     needs a ceiling as well as a floor (`DESKTOP_RELAY_MAX_TIMEOUT_MS`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const raw = vi.fn();
vi.mock('../../src/lib/tools/native/desktop-request', () => ({
  requestDesktopRaw: (...a: unknown[]) => raw(...a),
}));

import {
  EnvironmentManager,
  DESKTOP_RELAY_MIN_TIMEOUT_MS,
  DESKTOP_RELAY_MAX_TIMEOUT_MS,
  resolveDesktopRelayTimeoutMs,
} from '../../src/lib/environments/EnvironmentManager';
import { DesktopAgentSession, RELAY_GRACE_MS } from '../../src/lib/environments/DesktopAgentSession';
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

/** The `timeoutMs` of the most recent relay round-trip (how long the ENGINE waits). */
function lastRelayTimeout(): unknown {
  const call = raw.mock.calls.at(-1);
  return (call?.[0] as { timeoutMs?: unknown } | undefined)?.timeoutMs;
}

/** The `payload.timeoutMs` of the most recent relay op (the CONNECTOR's command budget). */
function lastCommandBudget(): unknown {
  const call = raw.mock.calls.at(-1);
  return (call?.[0] as { payload?: { timeoutMs?: unknown } } | undefined)?.payload?.timeoutMs;
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
    // The connector's budget is the floor; the engine waits that plus grace.
    expect(lastCommandBudget()).toBe(300_000);
    expect(lastRelayTimeout()).toBe(300_000 + RELAY_GRACE_MS);
  });

  it('never leaves the relay timeout undefined (the 12 s fall-through)', async () => {
    // A doc loaded from Mongo before the field existed has no idleTimeoutMs at all.
    const env = pushEnv({ environmentId: 'env_push_nofield' });
    delete (env as Partial<IEnvironment>).idleTimeoutMs;
    const session = await manager.acquire(env, '', 'user_a');
    await session.exec('echo hi');
    expect(lastCommandBudget()).toBe(300_000);
    expect(lastRelayTimeout()).toBe(300_000 + RELAY_GRACE_MS);
    expect(lastRelayTimeout()).not.toBeUndefined();
  });

  it('a longer idleTimeoutMs wins over the floor', async () => {
    const session = await manager.acquire(
      pushEnv({ environmentId: 'env_push_long', idleTimeoutMs: 900_000 }),
      '',
      'user_a',
    );
    await session.exec('echo hi');
    expect(lastCommandBudget()).toBe(900_000);
    expect(lastRelayTimeout()).toBe(900_000 + RELAY_GRACE_MS);
  });

  it('applies to desktop-agent environments too, not just cli', async () => {
    const session = await manager.acquire(
      pushEnv({ environmentId: 'env_push_da', kind: 'desktop-agent' }),
      '',
      'user_a',
    );
    await session.exec('echo hi');
    expect(lastCommandBudget()).toBe(300_000);
    expect(lastRelayTimeout()).toBe(300_000 + RELAY_GRACE_MS);
  });

  it('an explicit per-call timeout still wins', async () => {
    const session = await manager.acquire(pushEnv({ environmentId: 'env_push_opt' }), '', 'user_a');
    await session.exec('echo hi', { timeout: 30_000 });
    expect(lastCommandBudget()).toBe(30_000);
    expect(lastRelayTimeout()).toBe(30_000 + RELAY_GRACE_MS);
  });

  it('sftp ops get the session timeout as well (relay() path)', async () => {
    raw.mockResolvedValue({ ok: true, result: { contentB64: Buffer.from('x').toString('base64') } });
    const session = await manager.acquire(pushEnv({ environmentId: 'env_push_sftp' }), '', 'user_a');
    await session.sftpRead('/tmp/x');
    // sftp is a relay op with no command to bound, so no grace is added.
    expect(lastRelayTimeout()).toBe(300_000);
  });

  it('a Mongo idleTimeoutMs above the ceiling is clamped, not honoured', async () => {
    // Nothing validates idleTimeoutMs on write, so a fat-fingered 8 640 000 000
    // (100 days) is storable. DesktopAgentSession has no socket to drop and does
    // not observe abortSignal, so an unclamped wait is unreclaimable.
    const session = await manager.acquire(
      pushEnv({ environmentId: 'env_push_huge', idleTimeoutMs: 8_640_000_000 }),
      '',
      'user_a',
    );
    await session.exec('echo hi');
    expect(lastCommandBudget()).toBe(DESKTOP_RELAY_MAX_TIMEOUT_MS);
    expect(lastRelayTimeout()).toBe(DESKTOP_RELAY_MAX_TIMEOUT_MS + RELAY_GRACE_MS);
  });
});

describe('resolveDesktopRelayTimeoutMs — the clamp', () => {
  it('the ceiling matches toolExecutor\'s 30-minute tool-step watchdog', () => {
    expect(DESKTOP_RELAY_MAX_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(DESKTOP_RELAY_MAX_TIMEOUT_MS).toBeGreaterThan(DESKTOP_RELAY_MIN_TIMEOUT_MS);
  });

  it('clamps below to the floor and above to the ceiling', () => {
    expect(resolveDesktopRelayTimeoutMs(1)).toBe(DESKTOP_RELAY_MIN_TIMEOUT_MS);
    expect(resolveDesktopRelayTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(DESKTOP_RELAY_MAX_TIMEOUT_MS);
  });

  it('passes a value inside the band through untouched', () => {
    expect(resolveDesktopRelayTimeoutMs(600_000)).toBe(600_000);
  });

  it('never returns NaN or Infinity — those reinstate the 12 s fall-through', () => {
    // desktop-request only honours a FINITE positive timeoutMs; anything else
    // silently becomes its own DEFAULT_TIMEOUT_MS of 12 000. Math.max(NaN, x)
    // is NaN, which is exactly how the naive version leaked that back in.
    for (const bad of [undefined, null, NaN, Infinity, -Infinity, -1, 0]) {
      const got = resolveDesktopRelayTimeoutMs(bad as number | null | undefined);
      expect(Number.isFinite(got)).toBe(true);
      expect(got).toBe(DESKTOP_RELAY_MIN_TIMEOUT_MS);
    }
  });

  it('a non-numeric legacy value falls back to the floor', () => {
    expect(resolveDesktopRelayTimeoutMs('nonsense' as unknown as number)).toBe(DESKTOP_RELAY_MIN_TIMEOUT_MS);
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
    // It reaches the wire twice: verbatim as the connector's command budget,
    // and plus RELAY_GRACE_MS as the engine's wait for the reply.
    expect(lastCommandBudget()).toBe(300_000);
    expect(lastRelayTimeout()).toBe(300_000 + RELAY_GRACE_MS);
  });

  it('omitting it is what produced the 12 s fall-through', async () => {
    const s = new DesktopAgentSession(pushEnv(), 'user_a', 'cli-install-1');
    await s.exec('echo hi');
    // undefined here is precisely what makes desktop-request apply its own
    // DEFAULT_TIMEOUT_MS (12 000). The manager must never construct this way.
    expect(lastRelayTimeout()).toBeUndefined();
    expect(lastCommandBudget()).toBeUndefined();
  });
});

describe('DesktopAgentSession — the relay wait and the command budget are two clocks', () => {
  beforeEach(() => {
    raw.mockReset();
    raw.mockResolvedValue({ ok: true, result: { stdout: '', stderr: '', exitCode: 0, durationMs: 1 } });
  });

  it('never sends the two as the same number', async () => {
    // Equal values race: the engine abandons the round trip in the same tick
    // the connector composes its timeout reply, so a plain command timeout
    // surfaces as `desktop_failed: No desktop responded within Nms` — a
    // presence error for a connector that was present and answering.
    const s = new DesktopAgentSession(pushEnv(), 'user_a', 'cli-install-1', 300_000);
    await s.exec('sleep 999', { timeout: 120_000 });
    expect(lastCommandBudget()).toBe(120_000);
    expect(lastRelayTimeout()).not.toBe(lastCommandBudget());
    expect(lastRelayTimeout() as number).toBeGreaterThan(120_000);
  });

  it('the grace is enough for a kill-and-reply plus a Redis hop', () => {
    expect(RELAY_GRACE_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('a caller that omits timeout still hands the connector a budget to kill on', async () => {
    // read_file / glob / grep_files / list_dir call exec with no opts at all,
    // and ssh_shell's env path passes undefined at its default of 0. Those used
    // to ship a payload with no timeoutMs, so the connector ran the command
    // unbounded and kept it alive after the engine had stopped listening.
    const s = new DesktopAgentSession(pushEnv(), 'user_a', 'cli-install-1', 300_000);
    await s.exec('read -r x');
    expect(lastCommandBudget()).toBe(300_000);
  });

  it('timeout: 0 means "no explicit budget", not "kill immediately"', async () => {
    // ExecOptions documents 0 as no timeout; it must not become a 0 ms budget.
    const s = new DesktopAgentSession(pushEnv(), 'user_a', 'cli-install-1', 300_000);
    await s.exec('echo hi', { timeout: 0 });
    expect(lastCommandBudget()).toBe(300_000);
    expect(lastRelayTimeout()).toBe(300_000 + RELAY_GRACE_MS);
  });

  it('a NaN per-call timeout falls back to the session budget', async () => {
    const s = new DesktopAgentSession(pushEnv(), 'user_a', 'cli-install-1', 300_000);
    await s.exec('echo hi', { timeout: NaN });
    expect(lastCommandBudget()).toBe(300_000);
    expect(Number.isFinite(lastRelayTimeout() as number)).toBe(true);
  });
});
