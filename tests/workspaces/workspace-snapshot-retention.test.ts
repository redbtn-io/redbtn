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
 * Since 2026-09-16 the default and the CAP are separate (George: "give me the
 * best retention, if possible no time limit, just latest N"): the top two plans
 * may push `keepLast` to 100 and set `keepWithinDays` to 0, which is "no time
 * bound — keep the latest N, however old they are". The other three keep the
 * floor of 1 day, where a zero is a typo rather than a purchase.
 *
 * Hermetic: pure functions over the tier table plus an in-memory Db. No Mongo,
 * no Redis, no queue, no docker socket.
 */
import { describe, it, expect } from 'vitest';
import {
  WORKSPACE_TIER_POLICIES,
  WorkspaceRepository,
  WorkspaceSession,
  applyTierPolicy,
  buildReleaseJobData,
  clampSnapshotRetention,
  clampWorkspaceConfigForTier,
  describeSnapshotRetention,
  usableRetentionOutcome,
  workspaceTierPolicy,
  type LifecycleQueue,
  type WorkspaceTierName,
} from '../../src/lib/workspaces';

/** What each plan is documented to keep BY DEFAULT: [keepLast, keepWithinDays]. */
const EXPECTED: Record<WorkspaceTierName, [number, number]> = {
  admin: [30, 30],
  enterprise: [30, 30],
  pro: [10, 14],
  basic: [10, 14],
  free: [3, 7],
};

/** How far each plan may be pushed: [keepLast, keepWithinDays, allowNoTimeLimit]. */
const EXPECTED_MAX: Record<WorkspaceTierName, [number, number, boolean]> = {
  admin: [100, 30, true],
  enterprise: [100, 30, true],
  pro: [10, 14, false],
  basic: [10, 14, false],
  free: [3, 7, false],
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

  it('gives every tier a ceiling that is at least its default', () => {
    for (const [name, policy] of Object.entries(WORKSPACE_TIER_POLICIES)) {
      const [keepLast, keepWithinDays, allowNoTimeLimit] = EXPECTED_MAX[name as WorkspaceTierName];
      expect(policy.snapshotRetentionMax, `${name} has no ceiling`).toEqual({
        keepLast,
        keepWithinDays,
        allowNoTimeLimit,
      });
      // A cap below the default would hand out a policy the same table refuses
      // to accept back — every create would be clamped on the way in.
      expect(policy.snapshotRetentionMax.keepLast).toBeGreaterThanOrEqual(
        policy.snapshotRetention.keepLast,
      );
      expect(policy.snapshotRetentionMax.keepWithinDays).toBeGreaterThanOrEqual(
        policy.snapshotRetention.keepWithinDays,
      );
    }
    // Only the two plans that pay for it may drop the time bound.
    expect(workspaceTierPolicy(0).snapshotRetentionMax.allowNoTimeLimit).toBe(true);
    expect(workspaceTierPolicy(1).snapshotRetentionMax.allowNoTimeLimit).toBe(true);
    for (const tier of [2, 3, 4]) {
      expect(workspaceTierPolicy(tier).snapshotRetentionMax.allowNoTimeLimit).toBe(false);
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
    // Admin's keepLast ceiling is 100, so 99 is a legal ask; the window is still
    // capped at 30 days, because an unbounded WINDOW is asked for with 0.
    expect(
      clampWorkspaceConfigForTier({ snapshotRetention: { keepLast: 99, keepWithinDays: 99 } }, 0),
    ).toEqual({ snapshotRetention: { keepLast: 99, keepWithinDays: 30 } });
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

/**
 * "Backfill workspaces for sure but give me the best retention, if possible no
 * time limit, just latest N." — George, 2026-09-16.
 *
 * The tier table could not say it: `keepLast` was capped at the default it also
 * handed out, and every `keepWithinDays` was floored at 1 day, so the narrowest
 * time bound a workspace could ask for was "anything from yesterday". These are
 * the two halves of saying it, and the three plans that must NOT be able to.
 */
describe('the top plans can ask for the latest N and no time limit', () => {
  it('accepts keepWithinDays 0 on admin and enterprise, and floors it to 1 elsewhere', () => {
    for (const tier of [0, 1]) {
      expect(clampSnapshotRetention({ keepLast: 100, keepWithinDays: 0 }, workspaceTierPolicy(tier))).toEqual({
        keepLast: 100,
        keepWithinDays: 0,
      });
    }
    // A zero on a plan that did not buy it is a typo, not a purchase: reading it
    // as "forever" would grow storage on a slip of the finger.
    for (const [tier, keepLast] of [
      [2, 10],
      [3, 10],
      [4, 3],
    ] as Array<[number, number]>) {
      expect(clampSnapshotRetention({ keepLast: 999, keepWithinDays: 0 }, workspaceTierPolicy(tier))).toEqual({
        keepLast,
        keepWithinDays: 1,
      });
    }
    // Negative is a typo on EVERY plan, unbounded or not — "keep within -3 days"
    // is not a request for no bound, it is a slip, and it lands on the same
    // floor the tier would apply to a zero.
    expect(clampSnapshotRetention({ keepLast: 5, keepWithinDays: -3 }, workspaceTierPolicy(0))).toEqual({
      keepLast: 5,
      keepWithinDays: 0,
    });
    expect(clampSnapshotRetention({ keepLast: 5, keepWithinDays: -3 }, workspaceTierPolicy(2))).toEqual({
      keepLast: 5,
      keepWithinDays: 1,
    });
  });

  it('lets admin keep the last 100 and still caps basic at 10', () => {
    expect(clampSnapshotRetention({ keepLast: 100, keepWithinDays: 30 }, workspaceTierPolicy(0))).toEqual({
      keepLast: 100,
      keepWithinDays: 30,
    });
    expect(clampSnapshotRetention({ keepLast: 100, keepWithinDays: 30 }, workspaceTierPolicy(3))).toEqual({
      keepLast: 10,
      keepWithinDays: 14,
    });
    // Above the raised ceiling is still clamped, not refused.
    expect(clampSnapshotRetention({ keepLast: 5000, keepWithinDays: 0 }, workspaceTierPolicy(1))).toEqual({
      keepLast: 100,
      keepWithinDays: 0,
    });
  });

  it('leaves the DEFAULT alone — a new admin workspace still gets 30 and 30', async () => {
    // The point of splitting default from cap: raising the ceiling must not
    // quietly triple what every workspace on the plan starts out keeping.
    const { repo } = mkRepo();
    const ws = await repo.createWorkspace({ userId: 'user-1', name: 'admin-ws', accountTier: 0 } as any);
    expect(ws.config.snapshotRetention).toEqual({ keepLast: 30, keepWithinDays: 30 });

    // And asking for it explicitly is what gets you the unbounded policy.
    const unbounded = await repo.createWorkspace({
      userId: 'user-1',
      name: 'latest-n',
      accountTier: 0,
      config: { snapshotRetention: { keepLast: 100, keepWithinDays: 0 } },
    } as any);
    expect(unbounded.config.snapshotRetention).toEqual({ keepLast: 100, keepWithinDays: 0 });

    // An update is the other way in, and clamps the same.
    expect(
      clampWorkspaceConfigForTier({ snapshotRetention: { keepLast: 100, keepWithinDays: 0 } }, 1),
    ).toEqual({ snapshotRetention: { keepLast: 100, keepWithinDays: 0 } });
    expect(
      clampWorkspaceConfigForTier({ snapshotRetention: { keepLast: 100, keepWithinDays: 0 } }, 2),
    ).toEqual({ snapshotRetention: { keepLast: 10, keepWithinDays: 1 } });
  });
});

describe('describeSnapshotRetention — the one place that words it', () => {
  it('drops the window entirely when there is no time limit', () => {
    expect(describeSnapshotRetention({ keepLast: 100, keepWithinDays: 0 })).toBe('keep the last 100');
    // The whole reason this exists: a template that always prints the day count
    // renders `keepWithinDays: 0` as "within 0 days", which reads as the exact
    // opposite of what the policy means.
    expect(describeSnapshotRetention({ keepLast: 30, keepWithinDays: 30 })).toBe(
      'keep the last 30, within 30 days',
    );
    expect(describeSnapshotRetention({ keepLast: 10, keepWithinDays: 14 })).toBe(
      'keep the last 10, within 14 days',
    );
    expect(describeSnapshotRetention({ keepLast: 3, keepWithinDays: 1 })).toBe(
      'keep the last 3, within 1 day',
    );
  });

  it('says "keep everything" for the workspace that never agreed to a policy', () => {
    // Absent retention is not "keep nothing" — it is the pre-policy behaviour,
    // and a UI that said otherwise would describe a pruning that never happens.
    for (const junk of [undefined, null, {}, 'forever', 42, { keepWithinDays: 7 }, { keepLast: 0, keepWithinDays: 7 }]) {
      expect(describeSnapshotRetention(junk as any), `worded ${JSON.stringify(junk)}`).toBe(
        'keep everything',
      );
    }
  });

  it('words every tier default and every tier ceiling', () => {
    expect(describeSnapshotRetention(WORKSPACE_TIER_POLICIES.free.snapshotRetention)).toBe(
      'keep the last 3, within 7 days',
    );
    const admin = WORKSPACE_TIER_POLICIES.admin.snapshotRetentionMax;
    expect(
      describeSnapshotRetention({ keepLast: admin.keepLast, keepWithinDays: 0 }),
    ).toBe('keep the last 100');
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

  it('carries an unbounded policy verbatim, zero and all', () => {
    // The node reads `keepWithinDays: 0` as "omit --keep-within", so the zero
    // must survive the trip. Dropping it here would silently reinstate a time
    // bound the workspace paid to remove.
    const data = buildReleaseJobData({
      ...base,
      skipSnapshot: false,
      snapshotRetention: { keepLast: 100, keepWithinDays: 0 },
    });
    expect(data.snapshotRetention).toEqual({ keepLast: 100, keepWithinDays: 0 });

    // `keepLast: 0` is still nonsense — it would forget the snapshot this
    // release just took — and still means no policy at all.
    expect(
      buildReleaseJobData({
        ...base,
        skipSnapshot: false,
        snapshotRetention: { keepLast: 0, keepWithinDays: 0 },
      }),
    ).not.toHaveProperty('snapshotRetention');
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

/**
 * The other direction: what the node did comes BACK.
 *
 * Two live passes on 2026-09-15 logged "→ removed applied" and reported
 * `removed: null`, so nobody could tell whether a repository holding 15
 * snapshots under keep-last 3 had been trimmed at all. redrun now returns a
 * count on the job result; this is the half that remembers it, so the answer
 * survives the worker log's retention window and shows up on the workspace.
 */

/** Captures the release update instead of writing it. Enough Db for `releaseWorkspace`. */
function releaseCapture(checkout = { checkoutId: 'chk_1', runId: 'run_1' }) {
  const updates: Array<{ filter: any; update: any }> = [];
  const db = {
    collection() {
      return {
        async findOne() {
          return {
            activeCheckouts: [
              {
                ...checkout,
                mode: 'exclusive',
                checkoutKey: 'trunk',
                branch: 'main',
                createdAt: new Date('2026-09-15T21:00:00Z'),
              },
            ],
          };
        },
        async updateOne(filter: any, update: any) {
          updates.push({ filter, update });
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
    },
  } as any;
  return { repo: new WorkspaceRepository(db), updates };
}

const SNAPSHOT_META = {
  snapshotId: 'snap-1',
  snapshotSizeBytes: 42,
  fileCount: 7,
  computeSeconds: 3,
};

describe('releaseWorkspace records what the forget pass cost', () => {
  const release = (over: Record<string, unknown>) => ({
    workspaceId: 'ws_abc',
    checkoutId: 'chk_1',
    runId: 'run_1',
    commitTrunkSnapshot: true,
    snapshotMeta: SNAPSHOT_META,
    ...over,
  });

  it('writes the timestamp and the count beside the snapshot, in one update', async () => {
    const { repo, updates } = releaseCapture();
    await repo.releaseWorkspace(release({ retention: { keepLast: 3, keepWithinDays: 7, removed: 12 } }) as any);

    expect(updates).toHaveLength(1);
    const $set = updates[0].update.$set;
    expect($set['stats.lastSnapshotRetentionRemoved']).toBe(12);
    expect($set['stats.lastSnapshotRetentionAt']).toBeInstanceOf(Date);
    // The SAME instant as the snapshot it followed: one release is one write, so
    // a workspace page can never show this release's snapshot next to the last
    // release's prune.
    expect($set['stats.lastSnapshotRetentionAt']).toEqual($set['stats.lastSnapshotAt']);

    // Zero is a real answer — nothing was old enough — and must not be confused
    // with the unknown below.
    const none = releaseCapture();
    await none.repo.releaseWorkspace(
      release({ retention: { keepLast: 3, keepWithinDays: 7, removed: 0 } }) as any,
    );
    expect(none.updates[0].update.$set['stats.lastSnapshotRetentionRemoved']).toBe(0);

    // And null is "it ran, restic did not say": the timestamp still moves,
    // because the repository really was trimmed, only by an unknown amount.
    const unknown = releaseCapture();
    await unknown.repo.releaseWorkspace(
      release({ retention: { keepLast: 3, keepWithinDays: 7, removed: null } }) as any,
    );
    const set = unknown.updates[0].update.$set;
    expect(set['stats.lastSnapshotRetentionRemoved']).toBeNull();
    expect(set['stats.lastSnapshotRetentionAt']).toBeInstanceOf(Date);
  });

  it('touches neither field when the release says nothing about retention', async () => {
    // A workspace with no policy, a worker too old to report one, and a snapshot
    // that never came back are all this case. Stamping a null over the last real
    // count would erase the only record that the history was ever pruned.
    const { repo, updates } = releaseCapture();
    await repo.releaseWorkspace(release({}) as any);
    const $set = updates[0].update.$set;
    expect('stats.lastSnapshotRetentionAt' in $set).toBe(false);
    expect('stats.lastSnapshotRetentionRemoved' in $set).toBe(false);
    // The snapshot half of the same update is untouched by any of this.
    expect($set['stats.lastSnapshotAt']).toBeInstanceOf(Date);
    expect($set['currentSnapshotId']).toBe('snap-1');

    // Including on a teardown release, which takes no snapshot at all.
    const teardown = releaseCapture();
    await teardown.repo.releaseWorkspace({
      workspaceId: 'ws_abc',
      checkoutId: 'chk_1',
      runId: 'run_1',
      outcome: 'error',
    } as any);
    expect('stats.lastSnapshotRetentionAt' in teardown.updates[0].update.$set).toBe(false);
  });
});

describe('the release carries the forget outcome back off the job result', () => {
  /** A session over fakes: no Mongo, no Redis, no queue, no docker socket. */
  function session(snapshotResult: any) {
    const released: any[] = [];
    const repo = {
      async releaseWorkspace(options: any) {
        released.push(options);
      },
      async setWorkspaceNode() {},
      async clearWorkspaceNode() {},
      async clearParkedCheckout() {},
      async setParkedCheckout() {},
    } as any;
    const queue: LifecycleQueue = {
      async runJob() {
        if (snapshotResult instanceof Error) throw snapshotResult;
        return snapshotResult;
      },
    };
    const acquired = {
      workspace: {
        workspaceId: 'ws_abc',
        version: 1,
        config: { snapshotRetention: { keepLast: 3, keepWithinDays: 7 } },
      },
      checkout: { checkoutId: 'chk_1', runId: 'run_1', mode: 'exclusive', checkoutKey: 'trunk', installId: 'i' },
      environmentId: 'env_1',
      nodeId: '10.100.0.5',
      containerName: 'ws_abc_chk_1',
      volumeName: 'ws_abc_data',
    } as any;
    return { session: new WorkspaceSession(repo, acquired, queue, 60_000), released };
  }

  const snapshotOk = (over: Record<string, unknown> = {}) => ({
    ok: true,
    snapshotId: 'snap-1',
    snapshotSizeBytes: 42,
    fileCount: 7,
    durationSeconds: 3,
    ...over,
  });

  it('passes the node\'s count straight through to the repository', async () => {
    const s = session(snapshotOk({ retention: { keepLast: 3, keepWithinDays: 7, removed: 12 } }));
    await s.session.release();
    expect(s.released[0].retention).toEqual({ keepLast: 3, keepWithinDays: 7, removed: 12 });

    // `removed: null` — the worker's "it ran, restic did not say" — stays null
    // rather than collapsing to zero or dropping the whole outcome.
    const unknown = session(snapshotOk({ retention: { keepLast: 3, keepWithinDays: 7, removed: null } }));
    await unknown.session.release();
    expect(unknown.released[0].retention).toEqual({ keepLast: 3, keepWithinDays: 7, removed: null });
  });

  it('sends nothing when the node reported nothing, and never over a failed release', async () => {
    const quiet = session(snapshotOk());
    await quiet.session.release();
    expect('retention' in quiet.released[0]).toBe(false);

    // The snapshot job failed outright: the checkout is still given back, but
    // this release knows nothing about the repository and says nothing.
    const failed = session(new Error('snapshot timed out'));
    await failed.session.release();
    expect(failed.released[0].outcome).toBe('error');
    expect('retention' in failed.released[0]).toBe(false);
  });

  it('refuses a job result that is not the policy it claims to have applied', () => {
    expect(usableRetentionOutcome({ keepLast: 3, keepWithinDays: 7, removed: 12 })).toEqual({
      keepLast: 3,
      keepWithinDays: 7,
      removed: 12,
    });
    // An unbounded policy comes back the same way it went out.
    expect(usableRetentionOutcome({ keepLast: 100, keepWithinDays: 0, removed: 5 })).toEqual({
      keepLast: 100,
      keepWithinDays: 0,
      removed: 5,
    });
    // A count that is not a whole number of snapshots is an unknown, not a zero.
    for (const removed of [undefined, 'twelve', -1, NaN, Infinity, {}, true]) {
      expect(usableRetentionOutcome({ keepLast: 3, keepWithinDays: 7, removed })).toEqual({
        keepLast: 3,
        keepWithinDays: 7,
        removed: null,
      });
    }
    // No policy, no record: a malformed message must not stamp a timestamp and a
    // null over the last real answer.
    for (const junk of [undefined, null, {}, 'forgot', 42, [], { removed: 12 }, { keepLast: 0, keepWithinDays: 7, removed: 1 }]) {
      expect(usableRetentionOutcome(junk), `accepted ${JSON.stringify(junk)}`).toBeNull();
    }
  });
});
