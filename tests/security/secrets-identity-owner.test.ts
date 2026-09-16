/**
 * `secretsIdentity: 'owner'` — the automation-level opt-out from caller-scoped
 * secrets on a delegated run.
 *
 * # Why this exists
 *
 * Run-as-caller's rule (docs/RUN-AS-CALLER-DELEGATION-SPEC.md §1) is that a
 * delegated run resolves secrets against the CALLER and never falls back to the
 * owner, because the owner's secrets are the owner's own credentials. That is
 * right for a user's personal keys and wrong for a platform BOT: when the board
 * automation handed a second tenant's card to its graph, the `secretRefs` it
 * needed were `RED_BOARD_TOKEN` and `SSH_KEY` — the BOT's credentials, lent to
 * work performed on the tenant's behalf — and the run died before its first
 * node with `SecretsDelegationError` naming a caller who could not possibly
 * hold them (production, 2026-09-16 03:47Z).
 *
 * `secretsIdentity` splits the two cases at the automation level. `'caller'`
 * (the default for every delegated run, so nothing already in flight moves) is
 * the existing fail-closed behaviour. `'owner'` puts the secrets — and ONLY the
 * secrets — back on the owner's undelegated path; connections, environments and
 * workspaces stay caller-resolved, so the run still reaches nothing of the
 * owner's beyond the credentials the automation explicitly lends it.
 *
 * # How
 *
 * Same hermetic setup as `secret-userid-threading.test.ts`: `@redbtn/redsecrets`
 * is a lazy dynamic import, so the module is mocked and `repository.resolve`'s
 * arguments are captured. `mongoose.connection.db` is assigned a truthy fake so
 * the call site gets past its "not connected" guard without a live Mongo.
 * No Mongo, no Redis, no network.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';

import { resolveSecrets, SecretsDelegationError } from '../../src/lib/run/enrich-input';
import { __test__ as runInternals } from '../../src/functions/run';

const OWNER = 'user_owner';
const CALLER = 'user_caller';

// resolve() echoes `name -> 'OWNER_<name>'` so a resolved value is traceable
// back to the bucket it came from in an assertion.
const resolveMock = vi.hoisted(() =>
  vi.fn(async (_db: unknown, input: { names?: string[] }) =>
    Object.fromEntries((input?.names ?? []).map((n) => [n, `OWNER_${n}`])),
  ),
);

vi.mock('@redbtn/redsecrets', () => ({
  repository: { resolve: resolveMock },
}));

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

/** The board automation that broke: owned by the bot, declaring the bot's keys. */
const botAutomation = {
  automationId: 'auto_board_dispatch',
  userId: OWNER,
  secretNames: ['RED_BOARD_TOKEN', 'SSH_KEY'],
} as unknown as Parameters<typeof resolveSecrets>[2];

// ===========================================================================
// resolveSecrets — secretsIdentity: 'owner'
// ===========================================================================
describe("resolveSecrets — secretsIdentity:'owner' on a delegated run", () => {
  it("resolves the OWNER's secrets instead of failing closed on the caller", async () => {
    const { resolvedSecrets } = await resolveSecrets(
      {}, OWNER, botAutomation, 'run_owner_1', [], CALLER, 'owner',
    );

    // The bot's own credentials reach the run — the whole point.
    expect(resolvedSecrets).toEqual({
      RED_BOARD_TOKEN: 'OWNER_RED_BOARD_TOKEN',
      SSH_KEY: 'OWNER_SSH_KEY',
    });

    // Byte-for-byte the undelegated automation path: the automation's own
    // bucket, keyed to the automation's owner. The caller appears nowhere.
    expect(lastResolveInput()).toEqual(
      expect.objectContaining({
        names: ['RED_BOARD_TOKEN', 'SSH_KEY'],
        appName: 'redbtn',
        scope: 'automation',
        scopeId: 'auto_board_dispatch',
        userId: OWNER,
      }),
    );
    for (const call of resolveMock.mock.calls) {
      const input = call[1] as unknown as Record<string, unknown>;
      expect(input.userId).not.toBe(CALLER);
      expect(input.scopeId).not.toBe(CALLER);
    }
  });

  it('logs one greppable line saying the owner lent the secrets', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await resolveSecrets({}, OWNER, botAutomation, 'run_owner_2', [], CALLER, 'owner');

      const lines = log.mock.calls.map((c) => String(c[0]));
      const line = lines.find((l) => l.includes('secretsIdentity=owner'));
      expect(line).toBeDefined();
      expect(line).toContain(`secrets resolved as owner ${OWNER}`);
      expect(line).toContain('for delegated run run_owner_2');
    } finally {
      log.mockRestore();
    }
  });

  it('degrades like an undelegated run when a name does not resolve — no SecretsDelegationError', async () => {
    // Owner mode is the owner's path in full, which has always continued with
    // whatever resolved rather than erroring. Fail-closed belongs to 'caller'.
    resolveMock.mockResolvedValueOnce({ RED_BOARD_TOKEN: 'OWNER_RED_BOARD_TOKEN' });

    const { resolvedSecrets } = await resolveSecrets(
      {}, OWNER, botAutomation, 'run_owner_3', [], CALLER, 'owner',
    );

    expect(resolvedSecrets).toEqual({ RED_BOARD_TOKEN: 'OWNER_RED_BOARD_TOKEN' });
  });
});

// ===========================================================================
// resolveSecrets — 'caller' (default) is untouched
// ===========================================================================
describe("resolveSecrets — secretsIdentity:'caller' keeps failing closed", () => {
  it('still throws SecretsDelegationError when the caller holds nothing (explicit caller)', async () => {
    resolveMock.mockResolvedValueOnce({});

    await expect(
      resolveSecrets({}, OWNER, botAutomation, 'run_caller_1', [], CALLER, 'caller'),
    ).rejects.toMatchObject({
      name: 'SecretsDelegationError',
      code: 'SECRETS_DELEGATION_MISSING',
      callerUserId: CALLER,
      missingNames: ['RED_BOARD_TOKEN', 'SSH_KEY'],
    });
  });

  it('an omitted secretsIdentity is still caller-scoped and fail-closed (default unchanged)', async () => {
    resolveMock.mockResolvedValueOnce({});

    let thrown: unknown;
    try {
      await resolveSecrets({}, OWNER, botAutomation, 'run_caller_2', [], CALLER);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SecretsDelegationError);

    // And the lookup it attempted was the caller's own user bucket.
    expect(lastResolveInput()).toEqual(
      expect.objectContaining({ scope: 'user', scopeId: CALLER, userId: CALLER }),
    );
  });
});

// ===========================================================================
// Undelegated runs
// ===========================================================================
describe('resolveSecrets — undelegated runs are unaffected', () => {
  it("secretsIdentity:'owner' without a delegated identity changes nothing (and logs nothing)", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await resolveSecrets({}, 'user_triggerer', botAutomation, 'run_plain_1', [], undefined, 'owner');

      expect(lastResolveInput()).toEqual(
        expect.objectContaining({
          scope: 'automation',
          scopeId: 'auto_board_dispatch',
          userId: OWNER,
        }),
      );
      // Nothing was delegated, so there is nothing to announce.
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('secretsIdentity=owner'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('a user-scoped run with no automation is untouched by the new argument', async () => {
    await resolveSecrets({}, 'user_alice', null, 'run_plain_2', ['SSH_KEY'], undefined, 'owner');

    expect(lastResolveInput()).toEqual(
      expect.objectContaining({
        names: ['SSH_KEY'],
        scope: 'user',
        scopeId: 'user_alice',
        userId: 'user_alice',
      }),
    );
  });
});

// ===========================================================================
// Run state — data.secretsIdentity
// ===========================================================================
describe('buildInitialState — records secretsIdentity for audit', () => {
  const build = (options: Record<string, unknown>) =>
    (runInternals.buildInitialState as any)(
      {} as any,
      { message: 'hi' },
      { userId: OWNER, ...options } as any,
      { accountTier: 3, defaultNeuronId: 'n', defaultWorkerNeuronId: 'n', defaultGraphId: 'g' } as any,
      'run_state_1',
      null as any,
      new AbortController(),
      null,
    );

  it("stamps data.secretsIdentity='owner' on a delegated owner-mode run", () => {
    const state = build({ connectionIdentityUserId: CALLER, secretsIdentity: 'owner' });

    expect(state.data.secretsIdentity).toBe('owner');
    // The delegation itself is untouched: the caller is still on state.
    expect(state.callerUserId).toBe(CALLER);
    expect(state.data.callerUserId).toBe(CALLER);
    // And the owner is still the run's account.
    expect(state.userId).toBe(OWNER);
  });

  it("defaults to 'caller' on a delegated run that did not opt out", () => {
    const state = build({ connectionIdentityUserId: CALLER });
    expect(state.data.secretsIdentity).toBe('caller');
  });

  it('omits the field entirely on an undelegated run', () => {
    const state = build({});
    expect('secretsIdentity' in state.data).toBe(false);
    expect('callerUserId' in state.data).toBe(false);
  });
});
