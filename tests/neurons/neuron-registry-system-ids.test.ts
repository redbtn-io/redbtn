/**
 * NeuronRegistry — system-user id matching
 *
 * Companion to the GraphRegistry system-id fix. The platform-ownership
 * migration moved system neurons from `userId: 'system'` to the canonical
 * `SYSTEM_USER_ID`; NeuronRegistry only matched the legacy string, so a
 * migrated prod DB could not load any system neuron.
 *
 * These tests assert NeuronRegistry now matches BOTH id forms:
 *  - `getConfig` resolves a system neuron owned by the canonical ObjectId
 *    and builds a `{ $in: SYSTEM_USER_IDS }` filter.
 *  - `getConfig` resolves a system neuron's secret under the *caller's*
 *    userId (each caller pays from their own vault), but a user-owned
 *    neuron's secret under the owner's userId.
 *  - `validateAccess` passes for system neurons under either id form.
 *  - `getUserNeurons` queries both id forms.
 *
 * The `Neuron` mongoose model and `getDatabase` are mocked, and the private
 * `resolveSecret` is stubbed per-instance — no live MongoDB / vault needed.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { SYSTEM_USER_IDS, SYSTEM_USER_ID, LEGACY_SYSTEM_USER_ID } from '../../src/lib/system-users';

const findOneMock = vi.fn();
const findMock = vi.fn();

vi.mock('../../src/lib/models/Neuron', () => ({
  default: {
    findOne: (...args: unknown[]) => findOneMock(...args),
    find: (...args: unknown[]) => findMock(...args),
  },
}));

vi.mock('../../src/lib/memory/database', () => ({
  getDatabase: () => ({ connect: vi.fn(), close: vi.fn() }),
}));

// Imported after the mocks above are registered.
import { NeuronRegistry, NeuronAccessDeniedError } from '../../src/lib/neurons/NeuronRegistry';

const REAL_USER = '69a0b790a0ae8660290a78da';
const OTHER_OWNER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const EXPECTED_IN = { $in: [...SYSTEM_USER_IDS] };

function makeRegistry(): NeuronRegistry {
  return new NeuronRegistry({ databaseUrl: 'mongodb://mock/redbtn' });
}

function neuronDoc(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    neuronId: 'red-neuron',
    name: 'Red Neuron',
    provider: 'ollama',
    endpoint: 'http://localhost:11434',
    model: 'granite4:tiny-h',
    temperature: 0,
    maxTokens: 1024,
    topP: 1,
    role: 'worker',
    tier: 4,
    userId,
    ...overrides,
  };
}

beforeEach(() => {
  findOneMock.mockReset();
  findMock.mockReset();
});

describe('NeuronRegistry — getConfig system-id matching', () => {
  test('resolves a system neuron owned by the canonical ObjectId', async () => {
    findOneMock.mockResolvedValue(neuronDoc(SYSTEM_USER_ID));
    const cfg = await makeRegistry().getConfig('red-neuron', REAL_USER);
    expect(cfg.userId).toBe(SYSTEM_USER_ID);
    expect(cfg.id).toBe('red-neuron');
  });

  test('resolves a system neuron owned by the legacy "system" string', async () => {
    findOneMock.mockResolvedValue(neuronDoc(LEGACY_SYSTEM_USER_ID));
    const cfg = await makeRegistry().getConfig('red-neuron', REAL_USER);
    expect(cfg.userId).toBe(LEGACY_SYSTEM_USER_ID);
  });

  test('builds a { $in: SYSTEM_USER_IDS } filter on the system branch', async () => {
    findOneMock.mockResolvedValue(neuronDoc(SYSTEM_USER_ID));
    await makeRegistry().getConfig('red-neuron', REAL_USER);
    expect(findOneMock).toHaveBeenCalledWith({
      neuronId: 'red-neuron',
      $or: [{ userId: REAL_USER }, { userId: EXPECTED_IN }],
    });
  });
});

describe('NeuronRegistry — getConfig secret-owner resolution', () => {
  test('resolves a system neuron secret under the CALLER userId (canonical id)', async () => {
    findOneMock.mockResolvedValue(neuronDoc(SYSTEM_USER_ID, { secretName: 'OPENAI_KEY' }));
    const reg = makeRegistry();
    const resolveSecret = vi.fn().mockResolvedValue('sk-caller');
    (reg as unknown as { resolveSecret: typeof resolveSecret }).resolveSecret = resolveSecret;
    const cfg = await reg.getConfig('red-neuron', REAL_USER);
    expect(resolveSecret).toHaveBeenCalledWith('OPENAI_KEY', REAL_USER);
    expect(cfg.apiKey).toBe('sk-caller');
  });

  test('resolves a system neuron secret under the CALLER userId (legacy id)', async () => {
    findOneMock.mockResolvedValue(neuronDoc(LEGACY_SYSTEM_USER_ID, { secretName: 'OPENAI_KEY' }));
    const reg = makeRegistry();
    const resolveSecret = vi.fn().mockResolvedValue('sk-caller');
    (reg as unknown as { resolveSecret: typeof resolveSecret }).resolveSecret = resolveSecret;
    await reg.getConfig('red-neuron', REAL_USER);
    expect(resolveSecret).toHaveBeenCalledWith('OPENAI_KEY', REAL_USER);
  });

  test('resolves a user-owned neuron secret under the OWNER userId', async () => {
    findOneMock.mockResolvedValue(neuronDoc(OTHER_OWNER, { secretName: 'OPENAI_KEY' }));
    const reg = makeRegistry();
    const resolveSecret = vi.fn().mockResolvedValue('sk-owner');
    (reg as unknown as { resolveSecret: typeof resolveSecret }).resolveSecret = resolveSecret;
    await reg.getConfig('red-neuron', REAL_USER);
    expect(resolveSecret).toHaveBeenCalledWith('OPENAI_KEY', OTHER_OWNER);
  });
});

describe('NeuronRegistry — validateAccess', () => {
  test('passes for a system neuron owned by the canonical id', async () => {
    const reg = makeRegistry();
    await expect(
      (reg as unknown as { validateAccess: (c: unknown, u: string) => Promise<void> }).validateAccess(
        { id: 'red-neuron', userId: SYSTEM_USER_ID, tier: 4 },
        REAL_USER,
      ),
    ).resolves.toBeUndefined();
  });

  test('passes for a system neuron owned by the legacy id', async () => {
    const reg = makeRegistry();
    await expect(
      (reg as unknown as { validateAccess: (c: unknown, u: string) => Promise<void> }).validateAccess(
        { id: 'red-neuron', userId: LEGACY_SYSTEM_USER_ID, tier: 4 },
        REAL_USER,
      ),
    ).resolves.toBeUndefined();
  });

  test('still denies a private neuron owned by another real user', async () => {
    const reg = makeRegistry();
    await expect(
      (reg as unknown as { validateAccess: (c: unknown, u: string) => Promise<void> }).validateAccess(
        { id: 'private-neuron', userId: OTHER_OWNER, tier: 4 },
        REAL_USER,
      ),
    ).rejects.toBeInstanceOf(NeuronAccessDeniedError);
  });
});

describe('NeuronRegistry — getUserNeurons', () => {
  test('queries both id forms on the system branch', async () => {
    findMock.mockReturnValue({ sort: () => Promise.resolve([]) });
    await makeRegistry().getUserNeurons(REAL_USER);
    expect(findMock).toHaveBeenCalledWith({
      $or: [{ userId: REAL_USER }, { userId: EXPECTED_IN, tier: { $gte: 4 } }],
    });
  });
});
