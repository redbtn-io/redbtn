/**
 * Snapshot retention: how much restic history a workspace keeps.
 *
 * Every release of a trunk checkout wrote an UNTAGGED snapshot into the
 * workspace's own restic repository and nothing ever forgot one. The history
 * grew for the life of the workspace and was only collected when the workspace
 * itself was deleted (redrun #609 purges the whole repository then) — "we can't
 * be saving all of this data forever".
 *
 * The policy is a tier field like the warm and hot windows: the plan says how
 * much history is worth paying to keep, the create path writes the resolved
 * numbers onto the document, and the release job carries them to the node that
 * takes the backup so the forget happens in the same place.
 *
 * The one thing these guard hardest is the workspace that predates the field:
 * absent retention must stay absent all the way through, because the FREE
 * numbers on a document that never agreed to a policy would prune a paying
 * account's history on a guess.
 *
 * Hermetic: pure functions over the tier table plus an in-memory Db. No Mongo,
 * no Redis, no queue, no docker socket.
 */
import { describe, it, expect } from 'vitest';
import {
  WORKSPACE_TIER_POLICIES,
  WorkspaceRepository,
  applyTierPolicy,
  buildReleaseJobData,
  clampSnapshotRetention,
  clampWorkspaceConfigForTier,
  workspaceTierPolicy,
  type WorkspaceTierName,
} from '../../src/lib/workspaces';

/** What each plan is documented to keep: [keepLast, keepWithinDays]. */
const EXPECTED: Record<WorkspaceTierName, [number, number]> = {
  admin: [30, 30],
  enterprise: [30, 30],
  pro: [10, 14],
  basic: [10, 14],
  free: [3, 7],
};

/** Enough of a Db for WorkspaceRepository.createWorkspace. */
function fakeDb() {
  const docs: any[] = [];
  const db = {
    collection() {
      return {
        async insertOne(doc: any) {
          docs.push(doc);
          return { insertedId: doc.workspaceId };
        },
        async findOne() {
          return null;
        },
        async createIndex() {
          return '';
        },
      };
    },
  } as any;
  return { db, docs };
}

const mkRepo = () => {
  const { db, docs } = fakeDb();
  return { repo: new WorkspaceRepository(db), docs };
};

describe('the tier table carries a retention for every plan', () => {
  it('gives every tier both numbers, positive and whole', () => {
    for (const [name, policy] of Object.entries(WORKSPACE_TIER_POLICIES)) {
      const [keepLast, keepWithinDays] = EXPECTED[name as WorkspaceTierName];
      expect(policy.snapshotRetention, `${name} has no retention`).toBeDefined();
      expect(policy.snapshotRetention).toEqual({ keepLast, keepWithinDays });
      expect(Number.isInteger(policy.snapshotRetention.keepLast)).toBe(true);
      expect(policy.snapshotRetention.keepLast).toBeGreaterThan(0);
      expect(policy.snapshotRetention.keepWithinDays).toBeGreaterThan(0);
    }
  });

  it('keeps more history the more the plan pays, and puts unknown tiers on FREE', () => {
    expect(workspaceTierPolicy(0).snapshotRetention.keepLast).toBe(30);
    expect(workspaceTierPolicy(2).snapshotRetention.keepLast).toBe(10);
    expect(workspaceTierPolicy(4).snapshotRetention.keepLast).toBe(3);
    // Absent, out of range and nonsense all land on the lowest policy — the same
    // fallback the rest of the table uses, and the safe direction to be wrong in.
    for (const tier of [undefined, null, -1, 9, NaN, 'pro' as unknown as number]) {
      expect(workspaceTierPolicy(tier as number | null | undefined).snapshotRetention).toEqual({
        keepLast: 3,
        keepWithinDays: 7,
      });
    }
  });
});

describe('createWorkspace stores the resolved retention on the document', () => {
  it('fills both numbers from the owner tier when the caller asks for nothing', async () => {
    const { repo, docs } = mkRepo();
    const ws = await repo.createWorkspace({ userId: 'user-1', name: 'pro-ws', accountTier: 2 } as any);

    expect(ws.config.snapshotRetention).toEqual({ keepLast: 10, keepWithinDays: 14 });
    // And it is on the DOCUMENT, not just the returned object: the release path
    // reads it back out of Mongo, never off the create call.
    expect(docs[0].config.snapshotRetention).toEqual({ keepLast: 10, keepWithinDays: 14 });

    const free = await repo.createWorkspace({ userId: 'user-1', name: 'free-ws' } as any);
    expect(free.config.snapshotRetention).toEqual({ keepLast: 3, keepWithinDays: 7 });
  });

  it('clamps an explicit ask to the tier ceiling and lets a workspace keep less', async () => {
    const { repo } = mkRepo();
    const greedy = await repo.createWorkspace({
      userId: 'user-1',
      name: 'greedy',
      accountTier: 4,
      config: { snapshotRetention: { keepLast: 500, keepWithinDays: 365 } },
    } as any);
    expect(greedy.config.snapshotRetention).toEqual({ keepLast: 3, keepWithinDays: 7 });

    // Asking for LESS than the plan pays for is always allowed — the cap exists
    // to stop storage growing, not to force it.
    const frugal = await repo.createWorkspace({
      userId: 'user-1',
      name: 'frugal',
      accountTier: 0,
      config: { snapshotRetention: { keepLast: 2, keepWithinDays: 1 } },
    } as any);
    expect(frugal.config.snapshotRetention).toEqual({ keepLast: 2, keepWithinDays: 1 });
  });

  it('never writes a zero or a fragment of a policy', () => {
    const policy = workspaceTierPolicy(2);
    // A half-stated ask takes the other half from the tier rather than defaulting
    // to zero: a retention with a zero in it forgets everything.
    expect(clampSnapshotRetention({ keepLast: 4 }, policy)).toEqual({ keepLast: 4, keepWithinDays: 14 });
    expect(clampSnapshotRetention({ keepWithinDays: 0 }, policy)).toEqual({ keepLast: 10, keepWithinDays: 1 });
    expect(clampSnapshotRetention({ keepLast: -9, keepWithinDays: NaN }, policy)).toEqual({
      keepLast: 1,
      keepWithinDays: 14,
    });
    expect(clampSnapshotRetention(undefined, policy)).toEqual({ keepLast: 10, keepWithinDays: 14 });
    expect(applyTierPolicy(undefined, policy).snapshotRetention).toEqual({ keepLast: 10, keepWithinDays: 14 });
  });
});

describe('an update clamps the retention it mentions and invents none', () => {
  it('caps what the patch asks for at the tier, per field', () => {
    expect(
      clampWorkspaceConfigForTier({ snapshotRetention: { keepLast: 99, keepWithinDays: 3 } }, 3),
    ).toEqual({ snapshotRetention: { keepLast: 10, keepWithinDays: 3 } });
    expect(
      clampWorkspaceConfigForTier({ snapshotRetention: { keepLast: 99, keepWithinDays: 99 } }, 0),
    ).toEqual({ snapshotRetention: { keepLast: 30, keepWithinDays: 30 } });
  });

  it('stays silent about retention when the patch does not mention it', () => {
    // This is how a rename stops resetting every limit the user did not touch —
    // and it is also why an old workspace does NOT silently acquire a policy
    // from an unrelated edit to a field the patch never named.
    const out = clampWorkspaceConfigForTier({ warmTtlSeconds: 3600 }, 2);
    expect('snapshotRetention' in out).toBe(false);
    expect(clampWorkspaceConfigForTier({}, 2)).toEqual({});
    expect(clampWorkspaceConfigForTier({ snapshotRetention: null } as any, 2)).toEqual({});
  });
});

describe('the release job carries the policy only when it will take a snapshot', () => {
  const base = {
    workspaceId: 'ws_abc',
    checkoutId: 'chk_1',
    mode: 'exclusive' as const,
    checkoutKey: 'trunk',
  };
  const retention = { keepLast: 10, keepWithinDays: 14 };

  it('passes it on a release that backs the trunk up', () => {
    const data = buildReleaseJobData({ ...base, skipSnapshot: false, snapshotRetention: retention });
    expect(data).toMatchObject({ skipSnapshot: false, snapshotRetention: retention });
  });

  it('omits it on a teardown release, which adds no snapshot to prune against', () => {
    // `skipSnapshot` is the orphan-teardown and failed-run path. Forgetting
    // there would delete history this release did nothing to earn.
    const data = buildReleaseJobData({ ...base, skipSnapshot: true, snapshotRetention: retention });
    expect(data).not.toHaveProperty('snapshotRetention');
  });

  it('omits it for a workspace created before the field existed, so the node forgets nothing', () => {
    expect(buildReleaseJobData({ ...base, skipSnapshot: false })).not.toHaveProperty('snapshotRetention');
    expect(
      buildReleaseJobData({ ...base, skipSnapshot: false, snapshotRetention: undefined }),
    ).not.toHaveProperty('snapshotRetention');
    // Garbage is the same as absent: a half-written policy must not reach the
    // node as `--keep-last undefined`.
    for (const junk of [{}, { keepLast: 5 }, { keepLast: 0, keepWithinDays: 7 }, { keepLast: 'x', keepWithinDays: 7 }]) {
      expect(
        buildReleaseJobData({ ...base, skipSnapshot: false, snapshotRetention: junk as any }),
      ).not.toHaveProperty('snapshotRetention');
    }
  });

  it('leaves every other field of the job exactly as it was', () => {
    const data = buildReleaseJobData({ ...base, skipSnapshot: false, snapshotRetention: retention });
    expect(data).toMatchObject({
      action: 'snapshot',
      workspaceId: 'ws_abc',
      checkoutId: 'chk_1',
      mode: 'exclusive',
      checkoutKey: 'trunk',
      removeVolume: false,
    });
  });
});
