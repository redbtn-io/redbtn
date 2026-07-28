/**
 * Secret resolution — caller userId threading.
 *
 * # What's under test
 *
 * P0 multitenancy fix: every production `repository.resolve()` call site in the
 * engine must forward the caller's `userId` into the redsecrets resolve input,
 * alongside the existing `scope` / `scopeId`. The hardened redsecrets fallback
 * (>=0.2.0) uses that `userId` to constrain the global-bucket fallback so one
 * user's run can never resolve another user's (e.g. George's) global SSH_KEY.
 * The installed 0.1.0 ignores the extra field, so these tests lock the engine's
 * behaviour independently of the package upgrade.
 *
 * Three call sites are covered:
 *   1. src/lib/run/enrich-input.ts            → resolveSecrets()          (run path)
 *   2. src/lib/neurons/NeuronRegistry.ts      → resolveSecret()           (neuron API keys)
 *   3. src/lib/environments/loadAndResolveEnvironment.ts → defaultSecretsResolver() (SSH keys)
 *
 * # How
 *
 * `@redbtn/redsecrets` is a lazy dynamic import in all three modules, so we
 * mock the module and capture the `repository.resolve` call arguments. We do
 * NOT mock `mongoose` (the Neuron model builds a schema at import time, which
 * a partial mongoose mock would break) — instead we assign a truthy fake
 * `connection.db` onto the real mongoose singleton so the resolve() call is
 * reached without a live Mongo connection.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';

import { resolveSecrets } from '../../src/lib/run/enrich-input';
import { NeuronRegistry } from '../../src/lib/neurons/NeuronRegistry';
import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';

// ---------------------------------------------------------------------------
// Mock the lazy `@redbtn/redsecrets` dynamic import shared by all three sites.
// resolve() echoes `name -> 'MOCK_<name>'` so the environment path gets a
// non-empty sshKey and does not throw EnvironmentSecretMissingError.
// ---------------------------------------------------------------------------
const resolveMock = vi.hoisted(() =>
  vi.fn(async (_db: unknown, input: { names?: string[] }) =>
    Object.fromEntries((input?.names ?? []).map((n) => [n, `MOCK_${n}`])),
  ),
);

vi.mock('@redbtn/redsecrets', () => ({
  repository: { resolve: resolveMock },
}));

// Make `mongoose.connection.db` truthy without a real connection so each call
// site proceeds past its "MongoDB not connected" guard to the resolve() call.
const originalDb = (mongoose.connection as { db?: unknown }).db;
beforeEach(() => {
  resolveMock.mockClear();
  (mongoose.connection as { db?: unknown }).db = { collection: () => ({}) };
});
afterAll(() => {
  (mongoose.connection as { db?: unknown }).db = originalDb;
});

/** The redsecrets input is the 2nd positional arg of resolve(db, input, coll). */
function lastResolveInput(): Record<string, unknown> {
  expect(resolveMock).toHaveBeenCalled();
  const calls = resolveMock.mock.calls;
  return calls[calls.length - 1][1] as unknown as Record<string, unknown>;
}

// ===========================================================================
// Call site 1 — enrich-input.ts resolveSecrets()
// ===========================================================================
describe('enrich-input resolveSecrets — forwards userId', () => {
  it('user-scoped run: passes scope=user, scopeId=userId, userId=userId', async () => {
    await resolveSecrets({}, 'user_alice', null, 'run_1', ['SSH_KEY']);

    expect(lastResolveInput()).toEqual(
      expect.objectContaining({
        names: ['SSH_KEY'],
        appName: 'redbtn',
        scope: 'user',
        scopeId: 'user_alice',
        userId: 'user_alice',
      }),
    );
  });

  it("automation-scoped run: passes scope=automation, scopeId=automationId, userId=automation OWNER (not the triggerer)", async () => {
    const automationDoc = {
      automationId: 'auto_42',
      userId: 'user_owner',
      secretNames: ['SSH_KEY'],
    } as unknown as Parameters<typeof resolveSecrets>[2];

    // The run is triggered by a DIFFERENT user than the automation owner.
    await resolveSecrets({}, 'user_triggerer', automationDoc, 'run_2', []);

    expect(lastResolveInput()).toEqual(
      expect.objectContaining({
        names: ['SSH_KEY'],
        appName: 'redbtn',
        scope: 'automation',
        scopeId: 'auto_42',
        // Critical: the automation OWNER's userId, never the triggering user's.
        userId: 'user_owner',
      }),
    );
    expect(lastResolveInput().userId).not.toBe('user_triggerer');
  });

  it('does not call resolve() when there are no secret names to resolve', async () => {
    await resolveSecrets({}, 'user_alice', null, 'run_3', []);
    expect(resolveMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Call site 2 — NeuronRegistry.ts resolveSecret()
// ===========================================================================
describe('NeuronRegistry resolveSecret — forwards userId', () => {
  it('passes scope=user, scopeId=userId, userId=userId', async () => {
    const registry = new NeuronRegistry({ databaseUrl: 'mongodb://localhost:27017/test-noop' });

    // resolveSecret is private; invoke it directly for a focused unit assertion.
    const value = await (
      registry as unknown as { resolveSecret(name: string, userId: string): Promise<string | undefined> }
    ).resolveSecret('OPENAI_API_KEY', 'user_bob');

    expect(value).toBe('MOCK_OPENAI_API_KEY');
    expect(lastResolveInput()).toEqual(
      expect.objectContaining({
        names: ['OPENAI_API_KEY'],
        appName: 'redbtn',
        scope: 'user',
        scopeId: 'user_bob',
        userId: 'user_bob',
      }),
    );
  });
});

// ===========================================================================
// Call site 3 — loadAndResolveEnvironment.ts defaultSecretsResolver()
// ===========================================================================
describe('loadAndResolveEnvironment defaultSecretsResolver — forwards userId', () => {
  it("resolves in the env OWNER's scope with userId=owner", async () => {
    const rawDoc = {
      environmentId: 'env_1',
      userId: 'user_owner',
      name: 'Box',
      host: 'example.com',
      port: 2222,
      user: 'deploy',
      secretRef: 'SSH_KEY',
      isPublic: true,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    };

    // No secretsResolver injected → the production defaultSecretsResolver()
    // path runs, which is the resolve() call we are asserting on. A DIFFERENT
    // caller uses the public env; resolution must still be owner-scoped.
    const { sshKey } = await loadAndResolveEnvironment('env_1', 'user_caller', {
      findEnvironment: async () => rawDoc,
    });

    expect(sshKey).toBe('MOCK_SSH_KEY');
    expect(lastResolveInput()).toEqual(
      expect.objectContaining({
        names: ['SSH_KEY'],
        appName: 'redbtn',
        scope: 'user',
        scopeId: 'user_owner',
        userId: 'user_owner',
      }),
    );
    expect(lastResolveInput().userId).not.toBe('user_caller');
  });
});
