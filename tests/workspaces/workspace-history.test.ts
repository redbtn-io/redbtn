/**
 * The checkout history: what a workspace remembers after its run ended.
 *
 * `activeCheckouts` describes only what is live, and the release drops the
 * entry — so a person could not see that their workspace had run at all, on
 * which node, for how long, or what it shipped. `releaseWorkspace` now appends
 * a compact record to `checkoutHistory` (newest last, capped), and the two
 * shipping tools park the pull request on the live checkout so the release can
 * copy it across.
 *
 * Real MongoDB, for the reason workspace-repository.test.ts gives: the cap, the
 * `$push`/`$slice` and the array-filter write are the CAS engine's semantics,
 * not ours. Skipped (not failed) when no Mongo is reachable; point
 * WORKSPACE_TEST_MONGODB_URI at any throwaway server.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import {
  WorkspaceRepository,
  WorkspaceSession,
  CHECKOUT_HISTORY_LIMIT,
  workspaceNodeQueue,
  type ICheckoutHistoryEntry,
  type LifecycleQueue,
} from '../../src/lib/workspaces';
import ship from '../../src/lib/tools/native/workspace-ship';
import merge from '../../src/lib/tools/native/workspace-merge';

const URI = process.env.WORKSPACE_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = `workspace_history_test_${Date.now()}`;

let client: MongoClient | null = null;
let db: Db | null = null;
let available = false;

// Probed at module load, not in beforeAll: vitest evaluates `skipIf` during
// collection, so a beforeAll probe would skip every case unconditionally.
try {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  await client.connect();
  await client.db(DB_NAME).command({ ping: 1 });
  db = client.db(DB_NAME);
  available = true;
} catch {
  available = false;
  await client?.close().catch(() => {});
  client = null;
}

afterAll(async () => {
  if (db) await db.dropDatabase().catch(() => {});
  await client?.close().catch(() => {});
});

const PUSHED_PR = 'https://github.com/redbtn-io/webapp/pull/7';
const MERGED_SHA = 'b'.repeat(40);
const NODE = '10.100.0.8';

const parse = (r: any) => JSON.parse(r.content[0].text);
const ctx = (state: any) =>
  ({ state, publisher: null, runId: 'run-1', nodeId: 'n', toolId: 't', abortSignal: null }) as any;

/** A queue that answers the shipping jobs the way the node's worker does. */
function fakeQueue(overrides: Record<string, any> = {}) {
  const calls: Array<{ queueName: string; jobName: string; data: any }> = [];
  const queue: LifecycleQueue = {
    async runJob(queueName, jobName, data) {
      calls.push({ queueName, jobName, data });
      if (jobName in overrides) {
        const answer = overrides[jobName];
        if (answer instanceof Error) throw answer;
        return answer;
      }
      if (jobName === 'push') {
        return { ok: true, branch: data.branch, headSha: 'a'.repeat(40), prUrl: PUSHED_PR, prNumber: 7, created: true };
      }
      if (jobName === 'merge') {
        return { ok: true, merged: true, mergedSha: MERGED_SHA, prUrl: data.prUrl, checks: 'success' };
      }
      if (jobName === 'snapshot') {
        return { ok: true, snapshotId: 'snap_1', snapshotSizeBytes: 1024, fileCount: 3, volumeRemoved: false };
      }
      return { ok: false };
    },
    async hasWorkers() {
      return true;
    },
  };
  return { queue, calls };
}

describe.skipIf(!available)('checkout history', () => {
  let repo: WorkspaceRepository;

  beforeEach(async () => {
    await db!.collection('agentWorkspaces').deleteMany({});
    repo = new WorkspaceRepository(db!);
  });

  const mkWorkspace = (over: Record<string, any> = {}) =>
    repo.createWorkspace({
      userId: 'user-1',
      name: `ws-${Math.random().toString(36).slice(2)}`,
      config: { gitRepoUrl: 'https://github.com/redbtn-io/webapp.git', gitBranch: 'beta' },
      ...over,
    } as any);

  /** Backdate the live checkout so the release measures a real duration. */
  const backdate = (workspaceId: string, checkoutId: string, ms: number) =>
    db!.collection('agentWorkspaces').updateOne(
      { workspaceId },
      { $set: { 'activeCheckouts.$[elem].createdAt': new Date(Date.now() - ms) } },
      { arrayFilters: [{ 'elem.checkoutId': checkoutId }] },
    );

  const history = async (workspaceId: string): Promise<ICheckoutHistoryEntry[]> => {
    const doc = await db!.collection('agentWorkspaces').findOne({ workspaceId });
    return (doc?.checkoutHistory ?? []) as ICheckoutHistoryEntry[];
  };

  it('appends one entry per release, with the duration, the node and the outcome', async () => {
    const ws = await mkWorkspace();
    const { checkout } = await repo.checkoutWorkspace({
      workspaceId: ws.workspaceId,
      runId: 'run-a',
      workerId: 'w1',
      checkoutKey: 'card-42',
      mode: 'branch',
    });
    await repo.bindCheckoutRuntime(ws.workspaceId, checkout.checkoutId, 'run-a', {
      environmentId: 'env_real',
      nodeId: NODE,
      containerName: 'ws-runner-1',
    });
    await backdate(ws.workspaceId, checkout.checkoutId, 90_000);

    await repo.releaseWorkspace({
      workspaceId: ws.workspaceId,
      checkoutId: checkout.checkoutId,
      runId: 'run-a',
      commitTrunkSnapshot: true,
      snapshotMeta: { snapshotId: 'snap_1', snapshotSizeBytes: 1024, fileCount: 3, computeSeconds: 90 },
      volumeRemoved: true,
    });

    const entries = await history(ws.workspaceId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      checkoutId: checkout.checkoutId,
      runId: 'run-a',
      mode: 'branch',
      checkoutKey: 'card-42',
      branch: 'task/card-42',
      nodeId: NODE,
      outcome: 'released',
      volumeRemoved: true,
      snapshotId: 'snap_1',
    });
    expect(entries[0].durationMs).toBeGreaterThanOrEqual(90_000);
    expect(new Date(entries[0].releasedAt).getTime()).toBeGreaterThan(
      new Date(entries[0].acquiredAt).getTime(),
    );
    // The live list is still emptied — the history is a copy, not a move.
    const doc = await db!.collection('agentWorkspaces').findOne({ workspaceId: ws.workspaceId });
    expect(doc?.activeCheckouts).toHaveLength(0);
    expect(doc?.stats?.totalRunCount).toBe(1);
  });

  it('carries workspace_ship’s pull request, and workspace_merge’s sha, into the entry', async () => {
    const ws = await mkWorkspace();
    const { checkout } = await repo.checkoutWorkspace({
      workspaceId: ws.workspaceId,
      runId: 'run-b',
      workerId: 'w1',
      checkoutKey: 'card-7',
      mode: 'branch',
    });
    await repo.bindCheckoutRuntime(ws.workspaceId, checkout.checkoutId, 'run-b', {
      environmentId: 'env_real',
      nodeId: NODE,
    });

    const { queue, calls } = fakeQueue();
    const state = {
      data: {
        userId: 'user-1',
        ws: {
          workspaceId: ws.workspaceId,
          checkoutId: checkout.checkoutId,
          environmentId: 'env_real',
          nodeId: NODE,
          mode: 'branch',
          checkoutKey: 'card-7',
        },
      },
      workspaceDb: db,
      workspaceQueue: queue,
    };

    const shipped = parse(await ship.handler({ branch: 'red/fix', title: 'fix: it', environmentId: 'env_real' }, ctx(state)));
    expect(shipped.prUrl).toBe(PUSHED_PR);
    expect(calls[0].queueName).toBe(workspaceNodeQueue(NODE));

    const merged = parse(await merge.handler({ prUrl: PUSHED_PR, timeoutMs: 5000 }, ctx(state)));
    expect(merged.merged).toBe(true);

    // Parked on the LIVE checkout first — that is what the release copies.
    const live = await db!.collection('agentWorkspaces').findOne({ workspaceId: ws.workspaceId });
    expect(live?.activeCheckouts?.[0]?.pr).toEqual({ url: PUSHED_PR, mergedSha: MERGED_SHA });

    await repo.releaseWorkspace({
      workspaceId: ws.workspaceId,
      checkoutId: checkout.checkoutId,
      runId: 'run-b',
      volumeRemoved: true,
    });

    const entries = await history(ws.workspaceId);
    expect(entries).toHaveLength(1);
    expect(entries[0].pr).toEqual({ url: PUSHED_PR, mergedSha: MERGED_SHA });
  });

  it('leaves `pr` off a checkout that never shipped', async () => {
    const ws = await mkWorkspace();
    const { checkout } = await repo.checkoutWorkspace({
      workspaceId: ws.workspaceId,
      runId: 'run-c',
      workerId: 'w1',
    });

    await repo.releaseWorkspace({
      workspaceId: ws.workspaceId,
      checkoutId: checkout.checkoutId,
      runId: 'run-c',
    });

    const entries = await history(ws.workspaceId);
    expect(entries).toHaveLength(1);
    expect(entries[0].pr).toBeUndefined();
    expect(entries[0]).toMatchObject({ mode: 'exclusive', checkoutKey: 'trunk', branch: 'main', outcome: 'released' });
    // Nothing bound a runtime, so there is no node to claim one.
    expect(entries[0].nodeId).toBeUndefined();
  });

  it(`keeps only the newest ${CHECKOUT_HISTORY_LIMIT}, dropping the oldest`, async () => {
    const ws = await mkWorkspace();
    // Seed a full history rather than running fifty checkouts: the cap is the
    // `$slice` on the push, and it has to hold against a document that is
    // already at the limit.
    const seeded = Array.from({ length: CHECKOUT_HISTORY_LIMIT }, (_, i) => ({
      checkoutId: `chk_seed_${i}`,
      runId: `run_seed_${i}`,
      mode: 'exclusive',
      checkoutKey: 'trunk',
      branch: 'main',
      acquiredAt: new Date(Date.now() - (CHECKOUT_HISTORY_LIMIT - i) * 60_000),
      releasedAt: new Date(Date.now() - (CHECKOUT_HISTORY_LIMIT - i) * 60_000 + 1000),
      durationMs: 1000,
      outcome: 'released',
    }));
    await db!.collection('agentWorkspaces').updateOne(
      { workspaceId: ws.workspaceId },
      { $set: { checkoutHistory: seeded } },
    );

    const { checkout } = await repo.checkoutWorkspace({
      workspaceId: ws.workspaceId,
      runId: 'run-newest',
      workerId: 'w1',
    });
    await repo.releaseWorkspace({
      workspaceId: ws.workspaceId,
      checkoutId: checkout.checkoutId,
      runId: 'run-newest',
    });

    const entries = await history(ws.workspaceId);
    expect(entries).toHaveLength(CHECKOUT_HISTORY_LIMIT);
    expect(entries[entries.length - 1].runId).toBe('run-newest');
    // The oldest seeded entry fell off the front; the second-oldest leads now.
    expect(entries.map((e) => e.runId)).not.toContain('run_seed_0');
    expect(entries[0].runId).toBe('run_seed_1');
  });

  it('records `error` when the release had to give the checkout back after a failed snapshot', async () => {
    const ws = await mkWorkspace();
    const { checkout } = await repo.checkoutWorkspace({
      workspaceId: ws.workspaceId,
      runId: 'run-d',
      workerId: 'w1',
    });
    await repo.bindCheckoutRuntime(ws.workspaceId, checkout.checkoutId, 'run-d', {
      environmentId: 'env_real',
      nodeId: NODE,
    });

    const { queue } = fakeQueue({ snapshot: new Error('restic: repository is locked') });
    const session = new WorkspaceSession(
      repo,
      {
        workspace: ws,
        checkout: { ...checkout, nodeId: NODE },
        environmentId: 'env_real',
        nodeId: NODE,
        containerName: 'ws-runner-1',
        volumeName: checkout.volumeName,
      },
      queue,
      60_000,
    );
    await session.release();

    const entries = await history(ws.workspaceId);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe('error');
    expect(entries[0].snapshotId).toBeUndefined();
    // And the slot really did come back, which is the point of releasing anyway.
    const doc = await db!.collection('agentWorkspaces').findOne({ workspaceId: ws.workspaceId });
    expect(doc?.activeCheckouts).toHaveLength(0);
  });
});
