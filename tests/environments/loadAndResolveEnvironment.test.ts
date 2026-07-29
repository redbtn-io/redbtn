/**
 * loadAndResolveEnvironment — unit tests with injected dependencies.
 *
 * # What's under test
 *
 * The Phase B helper that bridges Mongo lookup + access check + secret
 * resolution. Tests inject `findEnvironment` and `secretsResolver` mocks so
 * we don't need a Mongo connection or a redsecrets repository.
 *
 * # Coverage matrix
 *
 *   - Happy path: doc exists, owner accesses, secret resolves
 *   - Missing doc → EnvironmentNotFoundError
 *   - Owner mismatch + not public → EnvironmentAccessDeniedError
 *   - Owner mismatch + public → resolves in the CALLER's secret scope, and the
 *     owner's scope is never consulted (P0: `isPublic` shares the environment,
 *     not the owner's private key)
 *   - Owner mismatch + public + caller has no such secret →
 *     EnvironmentSharedSecretMissingError, with no owner-scope fallback
 *   - desktop-agent / cli → short-circuit, no secret lookup at all
 *   - Empty secretRef → EnvironmentSecretMissingError
 *   - Secret resolves to empty/null → EnvironmentSecretMissingError
 *   - Defaults applied to partial doc
 *   - Bad inputs throw clean errors (not crash)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  loadAndResolveEnvironment,
  EnvironmentNotFoundError,
  EnvironmentAccessDeniedError,
  EnvironmentSecretMissingError,
  EnvironmentSharedSecretMissingError,
} from '../../src/lib/environments/loadAndResolveEnvironment';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRawDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environmentId: 'env_abc',
    userId: 'user_owner',
    name: 'Test Server',
    host: 'example.com',
    port: 2222,
    user: 'alice',
    secretRef: 'TEST_KEY',
    workingDir: '/srv',
    idleTimeoutMs: 60_000,
    maxLifetimeMs: 3_600_000,
    reconnect: { maxAttempts: 4, backoffMs: 1000, maxBackoffMs: 10_000 },
    archiveOutputLogs: true,
    isPublic: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('loadAndResolveEnvironment — happy paths', () => {
  it('owner can resolve their own environment', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc());
    const secretsResolver = vi.fn().mockResolvedValue('-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----');

    const { env, sshKey } = await loadAndResolveEnvironment('env_abc', 'user_owner', {
      findEnvironment,
      secretsResolver,
    });

    expect(env.environmentId).toBe('env_abc');
    expect(env.host).toBe('example.com');
    expect(env.port).toBe(2222);
    expect(env.user).toBe('alice');
    expect(env.secretRef).toBe('TEST_KEY');
    expect(sshKey).toMatch(/BEGIN RSA PRIVATE KEY/);
    expect(findEnvironment).toHaveBeenCalledWith('env_abc');
    // Caller IS the owner here, so the caller scope and the owner scope coincide.
    expect(secretsResolver).toHaveBeenCalledWith('TEST_KEY', 'user_owner');
  });

  it('owner of a PUBLIC env still resolves in their own scope', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc({ isPublic: true }));
    const secretsResolver = vi.fn().mockResolvedValue('owner-key-bytes');

    const { env, sshKey } = await loadAndResolveEnvironment('env_abc', 'user_owner', {
      findEnvironment,
      secretsResolver,
    });

    expect(env.isPublic).toBe(true);
    expect(sshKey).toBe('owner-key-bytes');
    expect(secretsResolver).toHaveBeenCalledWith('TEST_KEY', 'user_owner');
    expect(secretsResolver).toHaveBeenCalledTimes(1);
  });

  it("non-owner of a public env resolves in the CALLER's scope, never the owner's", async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc({ isPublic: true }));
    const secretsResolver = vi.fn().mockResolvedValue('callers-own-key-bytes');

    const { env, sshKey } = await loadAndResolveEnvironment('env_abc', 'user_other', {
      findEnvironment,
      secretsResolver,
    });

    expect(env.isPublic).toBe(true);
    // The caller gets THEIR key, not the owner's.
    expect(sshKey).toBe('callers-own-key-bytes');

    // P0 regression guard — assert on the resolver's call arguments, not just
    // the returned value, so an accidental owner-scope fallback fails loudly.
    expect(secretsResolver).toHaveBeenCalledWith('TEST_KEY', 'user_other');
    expect(secretsResolver).toHaveBeenCalledTimes(1);
    for (const [, scopeUserId] of secretsResolver.mock.calls) {
      expect(scopeUserId).not.toBe('user_owner');
    }
  });

  it('desktop-agent and cli envs short-circuit with no secret lookup', async () => {
    for (const kind of ['desktop-agent', 'cli'] as const) {
      const findEnvironment = vi.fn().mockResolvedValue(
        buildRawDoc({ kind, isPublic: true, host: undefined, user: undefined, secretRef: undefined }),
      );
      const secretsResolver = vi.fn();

      // Non-owner caller, to prove the short-circuit precedes any scope decision.
      const { env, sshKey } = await loadAndResolveEnvironment('env_abc', 'user_other', {
        findEnvironment,
        secretsResolver,
      });

      expect(env.kind).toBe(kind);
      expect(sshKey).toBe('');
      expect(secretsResolver).not.toHaveBeenCalled();
    }
  });

  it('applies Phase A defaults when fields are missing on the raw doc', async () => {
    const findEnvironment = vi.fn().mockResolvedValue({
      environmentId: 'env_minimal',
      userId: 'user_owner',
      name: 'Minimal',
      host: 'h.example.com',
      user: 'root',
      secretRef: 'K',
      createdAt: new Date(),
      updatedAt: new Date(),
      // No port, no idleTimeoutMs, no reconnect, no isPublic, no archiveOutputLogs
    });
    const secretsResolver = vi.fn().mockResolvedValue('key');

    const { env } = await loadAndResolveEnvironment('env_minimal', 'user_owner', {
      findEnvironment,
      secretsResolver,
    });

    expect(env.port).toBe(22); // default
    expect(env.idleTimeoutMs).toBe(5 * 60 * 1000);
    expect(env.maxLifetimeMs).toBe(8 * 60 * 60 * 1000);
    expect(env.reconnect.maxAttempts).toBe(5);
    expect(env.reconnect.backoffMs).toBe(2000);
    expect(env.reconnect.maxBackoffMs).toBe(30000);
    expect(env.archiveOutputLogs).toBe(true);
    expect(env.isPublic).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('loadAndResolveEnvironment — errors', () => {
  it('throws EnvironmentNotFoundError when the doc is missing', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(null);
    const secretsResolver = vi.fn();

    await expect(
      loadAndResolveEnvironment('env_missing', 'user_owner', { findEnvironment, secretsResolver }),
    ).rejects.toThrow(EnvironmentNotFoundError);
    // Secret resolver should NEVER be called when the doc is missing
    expect(secretsResolver).not.toHaveBeenCalled();
  });

  it('throws EnvironmentAccessDeniedError for non-owner on private env', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc({ isPublic: false }));
    const secretsResolver = vi.fn();

    await expect(
      loadAndResolveEnvironment('env_abc', 'user_other', { findEnvironment, secretsResolver }),
    ).rejects.toThrow(EnvironmentAccessDeniedError);
    // Secret resolver should NEVER be called when access is denied
    expect(secretsResolver).not.toHaveBeenCalled();
  });

  it('throws EnvironmentSecretMissingError when secretRef is empty', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc({ secretRef: '' }));
    const secretsResolver = vi.fn();

    await expect(
      loadAndResolveEnvironment('env_abc', 'user_owner', { findEnvironment, secretsResolver }),
    ).rejects.toThrow(EnvironmentSecretMissingError);
    expect(secretsResolver).not.toHaveBeenCalled();
  });

  it('throws EnvironmentSecretMissingError when secret resolves to null', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc());
    const secretsResolver = vi.fn().mockResolvedValue(null);

    await expect(
      loadAndResolveEnvironment('env_abc', 'user_owner', { findEnvironment, secretsResolver }),
    ).rejects.toThrow(EnvironmentSecretMissingError);
  });

  it('throws EnvironmentSecretMissingError when secret resolves to empty string', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc());
    const secretsResolver = vi.fn().mockResolvedValue('');

    await expect(
      loadAndResolveEnvironment('env_abc', 'user_owner', { findEnvironment, secretsResolver }),
    ).rejects.toThrow(EnvironmentSecretMissingError);
  });

  it('throws EnvironmentSharedSecretMissingError when a NON-owner lacks the secret', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc({ isPublic: true }));
    const secretsResolver = vi.fn().mockResolvedValue(null);

    await expect(
      loadAndResolveEnvironment('env_abc', 'user_other', { findEnvironment, secretsResolver }),
    ).rejects.toThrow(EnvironmentSharedSecretMissingError);

    // Exactly one lookup, in the caller's scope — no owner-scope retry.
    expect(secretsResolver).toHaveBeenCalledTimes(1);
    expect(secretsResolver).toHaveBeenCalledWith('TEST_KEY', 'user_other');
    expect(secretsResolver).not.toHaveBeenCalledWith('TEST_KEY', 'user_owner');
  });

  it('shared-secret error names the missing secret and yields no key material', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc({ isPublic: true }));
    const secretsResolver = vi.fn().mockResolvedValue('');

    try {
      await loadAndResolveEnvironment('env_abc', 'user_other', { findEnvironment, secretsResolver });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvironmentSharedSecretMissingError);
      expect((err as { code: string }).code).toBe('ENV_SHARED_SECRET_MISSING');
      expect((err as Error).message).toContain('TEST_KEY');
      expect((err as Error).message).toMatch(/your own scope/i);
      // The owner's key is not leaked through the error surface either.
      expect(JSON.stringify(err)).not.toContain('BEGIN');
      expect((err as { secretRef: string }).secretRef).toBe('TEST_KEY');
      expect((err as { userId: string }).userId).toBe('user_other');
    }
  });

  it('owner-path secret miss keeps the original ENV_SECRET_MISSING code', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc({ isPublic: true }));
    const secretsResolver = vi.fn().mockResolvedValue(null);

    try {
      await loadAndResolveEnvironment('env_abc', 'user_owner', { findEnvironment, secretsResolver });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvironmentSecretMissingError);
      expect((err as { code: string }).code).toBe('ENV_SECRET_MISSING');
    }
  });

  it('rejects empty environmentId arg', async () => {
    await expect(
      loadAndResolveEnvironment('', 'user_owner', {}),
    ).rejects.toThrow(/environmentId must be a non-empty string/);
  });

  it('rejects empty userId arg', async () => {
    await expect(
      loadAndResolveEnvironment('env_abc', '', {}),
    ).rejects.toThrow(/userId must be a non-empty string/);
  });

  it('error codes are stable for caller pattern-matching', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(null);
    try {
      await loadAndResolveEnvironment('env_x', 'user_x', { findEnvironment });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('ENV_NOT_FOUND');
      expect(err).toBeInstanceOf(EnvironmentNotFoundError);
    }

    const findOwnerOnly = vi.fn().mockResolvedValue(buildRawDoc());
    try {
      await loadAndResolveEnvironment('env_abc', 'someone_else', { findEnvironment: findOwnerOnly });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('ENV_ACCESS_DENIED');
      expect(err).toBeInstanceOf(EnvironmentAccessDeniedError);
    }

    const findGood = vi.fn().mockResolvedValue(buildRawDoc({ secretRef: '' }));
    try {
      await loadAndResolveEnvironment('env_abc', 'user_owner', { findEnvironment: findGood });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('ENV_SECRET_MISSING');
      expect(err).toBeInstanceOf(EnvironmentSecretMissingError);
    }
  });
});

// ---------------------------------------------------------------------------
// Date / mixed-type tolerance
// ---------------------------------------------------------------------------

describe('loadAndResolveEnvironment — input tolerance', () => {
  it('coerces ISO-string createdAt/updatedAt to Date', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(
      buildRawDoc({
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
        lastUsedAt: '2026-04-03T00:00:00.000Z',
      } as unknown as Record<string, unknown>),
    );
    const secretsResolver = vi.fn().mockResolvedValue('key');

    const { env } = await loadAndResolveEnvironment('env_abc', 'user_owner', {
      findEnvironment,
      secretsResolver,
    });

    expect(env.createdAt).toBeInstanceOf(Date);
    expect(env.updatedAt).toBeInstanceOf(Date);
    expect(env.lastUsedAt).toBeInstanceOf(Date);
    expect(env.createdAt.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('omits lastUsedAt when not present on the doc', async () => {
    const findEnvironment = vi.fn().mockResolvedValue(buildRawDoc());
    const secretsResolver = vi.fn().mockResolvedValue('key');

    const { env } = await loadAndResolveEnvironment('env_abc', 'user_owner', {
      findEnvironment,
      secretsResolver,
    });

    expect(env.lastUsedAt).toBeUndefined();
  });
});
