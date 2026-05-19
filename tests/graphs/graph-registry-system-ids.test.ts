/**
 * GraphRegistry — system-user id matching
 *
 * Regression coverage for the platform-ownership prod chat outage: the
 * migration moved system graphs from `userId: 'system'` to the canonical
 * `SYSTEM_USER_ID`, but GraphRegistry only matched the legacy string, so
 * every deployed engine failed to load `red-assistant` and chat died.
 *
 * These tests assert GraphRegistry now matches BOTH id forms:
 *  - `getConfig` resolves a system graph owned by the canonical ObjectId,
 *    and builds a `{ $in: SYSTEM_USER_IDS }` filter.
 *  - `validateAccess` grants tier-gated viewer access whichever id form a
 *    system graph carries.
 *  - `getUserGraphs` / `updateUsageStats` query both id forms.
 *
 * The `Graph` mongoose model and `getDatabase` are mocked — these are pure
 * query-shape + branch tests, no live MongoDB needed.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { SYSTEM_USER_IDS, SYSTEM_USER_ID, LEGACY_SYSTEM_USER_ID } from '../../src/lib/system-users';

const findOneMock = vi.fn();
const findMock = vi.fn();
const updateOneMock = vi.fn();

vi.mock('../../src/lib/models/Graph', () => ({
  Graph: {
    findOne: (...args: unknown[]) => findOneMock(...args),
    find: (...args: unknown[]) => findMock(...args),
    updateOne: (...args: unknown[]) => updateOneMock(...args),
  },
}));

vi.mock('../../src/lib/memory/database', () => ({
  getDatabase: () => ({ connect: vi.fn(), close: vi.fn() }),
}));

// compiler.ts `require()`s hand-maintained .js modules (nodeRegistry,
// conditionEvaluator) that only exist in dist/, not src/. These tests never
// compile a graph, so stub the module to keep the import graph loadable.
vi.mock('../../src/lib/graphs/compiler', () => ({
  compileGraphFromConfig: vi.fn(),
  GraphCompilationError: class GraphCompilationError extends Error {},
}));

// Imported after the mocks above are registered.
import { GraphRegistry, GraphAccessDeniedError } from '../../src/lib/graphs/GraphRegistry';

const REAL_USER = '69a0b790a0ae8660290a78da';
const EXPECTED_IN = { $in: [...SYSTEM_USER_IDS] };

function makeRegistry(): GraphRegistry {
  return new GraphRegistry({ databaseUrl: 'mongodb://mock/redbtn' });
}

function graphDoc(userId: string, overrides: Record<string, unknown> = {}) {
  const raw = { graphId: 'red-assistant', userId, tier: 4, nodes: [], edges: [], ...overrides };
  return { toObject: () => raw };
}

beforeEach(() => {
  findOneMock.mockReset();
  findMock.mockReset();
  updateOneMock.mockReset();
});

describe('GraphRegistry — getConfig system-id matching', () => {
  test('resolves a system graph owned by the canonical ObjectId', async () => {
    findOneMock.mockResolvedValue(graphDoc(SYSTEM_USER_ID));
    const cfg = await makeRegistry().getConfig('red-assistant', REAL_USER);
    expect(cfg.userId).toBe(SYSTEM_USER_ID);
    expect(cfg.graphId).toBe('red-assistant');
  });

  test('resolves a system graph owned by the legacy "system" string', async () => {
    findOneMock.mockResolvedValue(graphDoc(LEGACY_SYSTEM_USER_ID));
    const cfg = await makeRegistry().getConfig('red-assistant', REAL_USER);
    expect(cfg.userId).toBe(LEGACY_SYSTEM_USER_ID);
  });

  test('builds a { $in: SYSTEM_USER_IDS } filter on the system branch', async () => {
    findOneMock.mockResolvedValue(graphDoc(SYSTEM_USER_ID));
    await makeRegistry().getConfig('red-assistant', REAL_USER);
    expect(findOneMock).toHaveBeenCalledWith({
      graphId: 'red-assistant',
      $or: [{ userId: REAL_USER }, { userId: EXPECTED_IN }],
    });
  });
});

describe('GraphRegistry — validateAccess', () => {
  test('grants viewer access to a system graph owned by the canonical id', async () => {
    const reg = makeRegistry();
    (reg as unknown as { getUserTier: () => Promise<number> }).getUserTier = async () => 2;
    await expect(
      (reg as unknown as { validateAccess: (c: unknown, u: string) => Promise<void> }).validateAccess(
        { graphId: 'red-assistant', userId: SYSTEM_USER_ID, tier: 4 },
        REAL_USER,
      ),
    ).resolves.toBeUndefined();
  });

  test('grants viewer access to a system graph owned by the legacy id', async () => {
    const reg = makeRegistry();
    (reg as unknown as { getUserTier: () => Promise<number> }).getUserTier = async () => 2;
    await expect(
      (reg as unknown as { validateAccess: (c: unknown, u: string) => Promise<void> }).validateAccess(
        { graphId: 'red-assistant', userId: LEGACY_SYSTEM_USER_ID, tier: 4 },
        REAL_USER,
      ),
    ).resolves.toBeUndefined();
  });

  test('still enforces the tier gate on system graphs', async () => {
    const reg = makeRegistry();
    (reg as unknown as { getUserTier: () => Promise<number> }).getUserTier = async () => 4;
    await expect(
      (reg as unknown as { validateAccess: (c: unknown, u: string) => Promise<void> }).validateAccess(
        { graphId: 'pro-graph', userId: SYSTEM_USER_ID, tier: 0 },
        REAL_USER,
      ),
    ).rejects.toBeInstanceOf(GraphAccessDeniedError);
  });

  test('still denies a private graph owned by another real user', async () => {
    const reg = makeRegistry();
    await expect(
      (reg as unknown as { validateAccess: (c: unknown, u: string) => Promise<void> }).validateAccess(
        { graphId: 'private-graph', userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', tier: 4 },
        REAL_USER,
      ),
    ).rejects.toBeInstanceOf(GraphAccessDeniedError);
  });
});

describe('GraphRegistry — getUserGraphs / updateUsageStats', () => {
  test('getUserGraphs queries both id forms on the system branch', async () => {
    findMock.mockResolvedValue([]);
    const reg = makeRegistry();
    (reg as unknown as { getUserTier: () => Promise<number> }).getUserTier = async () => 3;
    await reg.getUserGraphs(REAL_USER);
    expect(findMock).toHaveBeenCalledWith({
      $or: [{ userId: REAL_USER }, { userId: EXPECTED_IN, tier: { $gte: 3 } }],
    });
  });

  test('updateUsageStats queries both id forms', async () => {
    updateOneMock.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });
    const reg = makeRegistry();
    await (
      reg as unknown as { updateUsageStats: (g: string, u: string) => Promise<void> }
    ).updateUsageStats('red-assistant', REAL_USER);
    expect(updateOneMock).toHaveBeenCalledWith(
      { graphId: 'red-assistant', $or: [{ userId: REAL_USER }, { userId: EXPECTED_IN }] },
      expect.any(Object),
    );
  });
});
