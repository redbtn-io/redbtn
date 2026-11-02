/**
 * browser environments — engine-core unit tests (redbtn Browser extension).
 *
 * Verifies:
 *  - loadAndResolveEnvironment resolves a `browser` doc with NO secret lookup
 *    (push-model short-circuit, sshKey '') and applyDefaults preserves the
 *    `browser` kind instead of coercing it to `self-hosted`.
 *  - BrowserSession opens, and its exec/sftp surface rejects as unsupported.
 *  - EnvironmentManager.acquire() constructs a BrowserSession for a browser
 *    env (not DesktopAgentSession / EnvironmentSession).
 *
 * No Mongo, no Redis, no network — deps are injected / sessions are local.
 */
import { describe, it, expect, vi } from 'vitest';
import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import { BrowserSession, BrowserUnsupportedError } from '../../src/lib/environments/BrowserSession';
import { EnvironmentManager } from '../../src/lib/environments/EnvironmentManager';
import type { IEnvironment } from '../../src/lib/environments/types';

function buildRawDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environmentId: 'env_browser',
    userId: 'user_owner',
    name: 'Test Browser',
    kind: 'browser',
    installId: 'install_1',
    idleTimeoutMs: 60_000,
    maxLifetimeMs: 3_600_000,
    reconnect: { maxAttempts: 4, backoffMs: 1000, maxBackoffMs: 10_000 },
    archiveOutputLogs: false,
    isPublic: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  };
}

function buildBrowserEnv(overrides: Partial<IEnvironment> = {}): IEnvironment {
  return {
    environmentId: 'env_browser',
    userId: 'user_1',
    name: 'Test Browser',
    kind: 'browser',
    installId: 'install_1',
    port: 22,
    idleTimeoutMs: 60_000,
    maxLifetimeMs: 3_600_000,
    reconnect: { maxAttempts: 3, backoffMs: 50, maxBackoffMs: 500 },
    archiveOutputLogs: false,
    isPublic: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  };
}

describe('loadAndResolveEnvironment — browser kind', () => {
  it('resolves with no secret lookup, sshKey empty, kind preserved', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc({ secretRef: undefined }));
    const secretsResolver = vi.fn();

    const { env, sshKey } = await loadAndResolveEnvironment('env_browser', 'user_owner', {
      findEnvironment,
      secretsResolver,
    });

    // applyDefaults must NOT coerce 'browser' to 'self-hosted'.
    expect(env.kind).toBe('browser');
    expect(env.environmentId).toBe('env_browser');
    expect(sshKey).toBe('');
    expect(secretsResolver).not.toHaveBeenCalled();
  });
});

describe('BrowserSession', () => {
  it('opens and reports state open', async () => {
    const session = new BrowserSession(buildBrowserEnv(), 'user_1', 'install_1');
    expect(session.environmentId).toBe('env_browser');
    await session.open();
    expect(session.state).toBe('open');
    await session.close();
    expect(session.state).toBe('closed');
  });

  it('exec rejects as unsupported', async () => {
    const session = new BrowserSession(buildBrowserEnv(), 'user_1', 'install_1');
    await session.open();
    await expect(session.exec('ls')).rejects.toThrow(/unsupported: browser environments have no/);
    await expect(session.exec('ls')).rejects.toBeInstanceOf(BrowserUnsupportedError);
  });

  it('sftp surface rejects as unsupported', async () => {
    const session = new BrowserSession(buildBrowserEnv(), 'user_1', 'install_1');
    await session.open();
    await expect(session.sftpRead('/x')).rejects.toThrow(/unsupported: browser environments have no/);
    await expect(session.sftpWrite('/x', 'data')).rejects.toThrow(/unsupported: browser environments have no/);
    await expect(session.sftpStat('/x')).rejects.toThrow(/unsupported: browser environments have no/);
    await expect(session.sftpReaddir('/x')).rejects.toThrow(/unsupported: browser environments have no/);
  });

  it('BrowserUnsupportedError carries code unsupported', async () => {
    const session = new BrowserSession(buildBrowserEnv(), 'user_1', 'install_1');
    const err = await session.exec('ls').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserUnsupportedError);
    expect((err as BrowserUnsupportedError).code).toBe('unsupported');
  });
});

describe('EnvironmentManager — browser kind', () => {
  it('acquire returns an open BrowserSession', async () => {
    const manager = new EnvironmentManager();
    try {
      const session = await manager.acquire(buildBrowserEnv(), '', 'user_1');
      expect(session).toBeInstanceOf(BrowserSession);
      expect(session.state).toBe('open');
    } finally {
      await manager.closeAll();
    }
  });
});
