/**
 * NeuronRegistry — public-neuron + tiered access (redbtn board card 6ab1851ebd51bc0660377da1).
 *
 * Covers the Engine fix:
 *   1. A neuron marked public (`isPublic: true`) loads for a run owned by
 *      another user (`getConfig` matches the `{ isPublic: true }` branch and
 *      `validateAccess` allows it).
 *   2. A private neuron owned by user A is denied for user B.
 *   3. System-neuron tier gating reads the real account level: tier 0
 *      (admin) / tier 1 can access a tier-2 system neuron, tier 4 (free) is
 *      denied. (Lower number = higher entitlement.)
 *   4. `getUserTier` reads `accountLevel` from the Mongoose `User` model and
 *      defaults to 4 when the user is missing / has no level / lookup fails.
 *   5. `getUserNeurons` queries the `{ isPublic: true }` branch and maps
 *      `isPublic` onto the returned configs.
 *
 * No database connection is used: the `Neuron` model is mocked and the `User`
 * lookup is stubbed via the real mongoose singleton (`getUserTier` reads
 * `mongoose.models['User']`, mirroring `GraphRegistry`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';

import {
  NeuronRegistry,
  NeuronAccessDeniedError,
} from '../../src/lib/neurons/NeuronRegistry';
import Neuron from '../../src/lib/models/Neuron';
import { SYSTEM_USER_ID } from '../../src/lib/system-resource';
import type { NeuronConfig } from '../../src/lib/types/neuron';

vi.mock('../../src/lib/models/Neuron', () => ({
  default: {
    findOne: vi.fn(),
    find: vi.fn(),
  },
}));

const findOneMock = vi.mocked(Neuron.findOne);
const findMock = vi.mocked(Neuron.find);

type RegistryInternals = {
  validateAccess(config: NeuronConfig, userId: string): Promise<void>;
  getUserTier(userId: string): Promise<number>;
};

function internals(registry: NeuronRegistry): RegistryInternals {
  return registry as unknown as RegistryInternals;
}

function makeRegistry(): NeuronRegistry {
  // Fresh instance per test => fresh LRU config cache, no cross-test leakage.
  return new NeuronRegistry({ databaseUrl: 'mongodb://localhost:27017/test-noop' });
}

/** Minimal persisted-doc shape `getConfig` reads (no `secretName` => no vault lookup). */
function neuronDoc(overrides: Record<string, unknown> = {}) {
  return {
    neuronId: 'neuron-1',
    userId: 'user_a',
    name: 'Test Neuron',
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0,
    maxTokens: 1024,
    topP: 1,
    role: 'worker',
    tier: 4,
    isPublic: false,
    ...overrides,
  };
}

/** Minimal `NeuronConfig` shape `validateAccess` reads. */
function neuronConfig(overrides: Partial<NeuronConfig> = {}): NeuronConfig {
  return {
    id: 'neuron-1',
    name: 'Test Neuron',
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    role: 'worker',
    tier: 4,
    userId: 'user_a',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub the Mongoose `User` model `getUserTier` reads via `require('mongoose')`.
// ---------------------------------------------------------------------------
const originalUserModel = (mongoose.models as Record<string, unknown>)['User'];

function mockAccountLevel(resolved: unknown, rejects = false) {
  (mongoose.models as Record<string, unknown>)['User'] = {
    findById: (_id: string) => ({
      lean: async () => {
        if (rejects) throw new Error('mongo down');
        return resolved;
      },
    }),
  };
}

afterEach(() => {
  if (originalUserModel === undefined) {
    delete (mongoose.models as Record<string, unknown>)['User'];
  } else {
    (mongoose.models as Record<string, unknown>)['User'] = originalUserModel;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// 1. Public neuron loads + validates for another user
// ===========================================================================
describe('public neuron access', () => {
  it('loads a public neuron owned by user A for user B', async () => {
    findOneMock.mockResolvedValue(neuronDoc({ userId: 'user_a', isPublic: true }) as never);

    const registry = makeRegistry();
    const config = await registry.getConfig('neuron-1', 'user_b');

    expect(config.id).toBe('neuron-1');
    expect(config.isPublic).toBe(true);
    // The query must carry the public branch, mirroring GraphRegistry.
    expect(findOneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        neuronId: 'neuron-1',
        $or: expect.arrayContaining([{ userId: 'user_b' }, { isPublic: true }]),
      }),
    );
  });

  it('validates a public non-system neuron for a non-owner', async () => {
    const registry = makeRegistry();
    await expect(
      internals(registry).validateAccess(
        neuronConfig({ userId: 'user_a', isPublic: true }),
        'user_b',
      ),
    ).resolves.toBeUndefined();
  });
});

// ===========================================================================
// 2. Private neuron denied for another user
// ===========================================================================
describe('private neuron access', () => {
  it('denies user B access to user A\'s private neuron', async () => {
    const registry = makeRegistry();
    await expect(
      internals(registry).validateAccess(
        neuronConfig({ userId: 'user_a', isPublic: false }),
        'user_b',
      ),
    ).rejects.toBeInstanceOf(NeuronAccessDeniedError);
  });

  it('denies when isPublic is unset (default private)', async () => {
    const registry = makeRegistry();
    const { isPublic: _dropped, ...withoutFlag } = neuronConfig({ userId: 'user_a' });
    void _dropped;
    await expect(
      internals(registry).validateAccess(withoutFlag, 'user_b'),
    ).rejects.toBeInstanceOf(NeuronAccessDeniedError);
  });

  it('still allows the owner', async () => {
    const registry = makeRegistry();
    await expect(
      internals(registry).validateAccess(
        neuronConfig({ userId: 'user_a', isPublic: false }),
        'user_a',
      ),
    ).resolves.toBeUndefined();
  });
});

// ===========================================================================
// 3. System-neuron tier gating (lower number = higher entitlement)
// ===========================================================================
describe('system neuron tier access', () => {
  const systemTier2 = () =>
    neuronConfig({ id: 'sys-neuron', userId: SYSTEM_USER_ID, tier: 2 });

  it('admin (tier 0) can access a tier-2 system neuron', async () => {
    mockAccountLevel({ _id: 'user_admin', accountLevel: 0 });
    const registry = makeRegistry();
    await expect(
      internals(registry).validateAccess(systemTier2(), 'user_admin'),
    ).resolves.toBeUndefined();
  });

  it('tier 1 can access a tier-2 system neuron', async () => {
    mockAccountLevel({ _id: 'user_t1', accountLevel: 1 });
    const registry = makeRegistry();
    await expect(
      internals(registry).validateAccess(systemTier2(), 'user_t1'),
    ).resolves.toBeUndefined();
  });

  it('free (tier 4) is denied access to a tier-2 system neuron', async () => {
    mockAccountLevel({ _id: 'user_free', accountLevel: 4 });
    const registry = makeRegistry();
    await expect(
      internals(registry).validateAccess(systemTier2(), 'user_free'),
    ).rejects.toBeInstanceOf(NeuronAccessDeniedError);
  });
});

// ===========================================================================
// 4. getUserTier reads accountLevel, defaults to 4
// ===========================================================================
describe('getUserTier', () => {
  it('returns the accountLevel from the User model', async () => {
    mockAccountLevel({ _id: 'u1', accountLevel: 1 });
    await expect(internals(makeRegistry()).getUserTier('u1')).resolves.toBe(1);
  });

  it('returns 0 for admins', async () => {
    mockAccountLevel({ _id: 'u0', accountLevel: 0 });
    await expect(internals(makeRegistry()).getUserTier('u0')).resolves.toBe(0);
  });

  it('defaults to 4 when the user does not exist', async () => {
    mockAccountLevel(null);
    await expect(internals(makeRegistry()).getUserTier('ghost')).resolves.toBe(4);
  });

  it('defaults to 4 when accountLevel is missing or not a number', async () => {
    mockAccountLevel({ _id: 'u2' });
    await expect(internals(makeRegistry()).getUserTier('u2')).resolves.toBe(4);

    mockAccountLevel({ _id: 'u3', accountLevel: 'admin' });
    await expect(internals(makeRegistry()).getUserTier('u3')).resolves.toBe(4);
  });

  it('defaults to 4 when the lookup throws', async () => {
    mockAccountLevel(null, true);
    await expect(internals(makeRegistry()).getUserTier('u4')).resolves.toBe(4);
  });
});

// ===========================================================================
// 5. getUserNeurons includes the public branch and maps isPublic
// ===========================================================================
describe('getUserNeurons', () => {
  it('queries { isPublic: true } and returns isPublic on each config', async () => {
    mockAccountLevel({ _id: 'user_b', accountLevel: 4 });
    const docs = [
      neuronDoc({ neuronId: 'own-1', userId: 'user_b', isPublic: false }),
      neuronDoc({ neuronId: 'pub-1', userId: 'user_a', isPublic: true }),
    ];
    const sortMock = vi.fn().mockResolvedValue(docs);
    findMock.mockReturnValue({ sort: sortMock } as never);

    const registry = makeRegistry();
    const configs = await registry.getUserNeurons('user_b');

    expect(findMock).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: expect.arrayContaining([{ userId: 'user_b' }, { isPublic: true }]),
      }),
    );
    expect(configs).toHaveLength(2);
    expect(configs.find((c) => c.id === 'own-1')).toMatchObject({ isPublic: false });
    expect(configs.find((c) => c.id === 'pub-1')).toMatchObject({ isPublic: true });
  });
});
