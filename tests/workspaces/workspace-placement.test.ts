/**
 * Placement: which queue a spawn goes to, and how long the node pin survives.
 *
 * The pin used to be written once and never cleared or aged, so a workspace
 * whose node left the fleet enqueued every later spawn onto `workspace-
 * lifecycle--<gone>` — a queue with no consumer — and each run died at the
 * five-minute spawn timeout (51a). The pin now follows the warm data: it ages
 * out with the node's volume reaper, it is skipped when that node has no live
 * worker, and a release that removed the volume drops it entirely.
 *
 * Real MongoDB (see workspace-repository.test.ts for why), queue and gateway
 * injected, so nothing here needs Redis.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import {
  acquireWorkspace,
  WorkspaceRepository,
  DEFAULT_WARM_TTL_SECONDS,
  WORKSPACE_QUEUE,
  workspaceNodeQueue,
  type LifecycleQueue,
} from '../../src/lib/workspaces';

const URI = process.env.WORKSPACE_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = `workspace_placement_test_${Date.now()}`;

let client: MongoClient | null = null;
let db: Db | null = null;
let available = false;
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

type Enqueued = { queueName: string; jobName: string; data: Record<string, unknown> };

/** Records where jobs went and which queues were probed for a live consumer. */
function fakeQueue(results: Record<string, any> = {}, workers: (queueName: string) => boolean = () => true) {
  const jobs: Enqueued[] = [];
  const probes: string[] = [];
  const queue: LifecycleQueue = {
    async runJob(queueName, jobName, data) {
      jobs.push({ queueName, jobName, data });
      return results[jobName];
    },
    async hasWorkers(queueName) {
      probes.push(queueName);
      return workers(queueName);
    },
  };
  return { queue, jobs, probes };
}

const spawnOk = (nodeId: string) => ({
  ok: true,
  containerName: 'ws_abc_chk1',
  volumeName: 'ws_abc_data',
  installId: 'x',
  nodeId,
});

const gateway = { findByInstallId: async () => ({ environmentId: 'env_ok' }) };

/** How far in the future the stored pin sits, in seconds. */
const pinSeconds = (until: Date | null | undefined) =>
  until ? Math.round((new Date(until).getTime() - Date.now()) / 1000) : NaN;

const WARM = '10.100.0.5';
const OTHER = '10.100.0.7';

describe('workspace placement (node pin, warm window, live worker)', () => {
  let repo: WorkspaceRepository;
  const OLD_KEY = process.env.INTERNAL_SERVICE_KEY;

  beforeEach(async () => {
    if (!available) return;
    process.env.INTERNAL_SERVICE_KEY = 'test-internal-service-key';
    await db!.collection('agentWorkspaces').deleteMany({});
    repo = new WorkspaceRepository(db!);
  });

  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.INTERNAL_SERVICE_KEY;
    else process.env.INTERNAL_SERVICE_KEY = OLD_KEY;
  });

  // Tier 2 (Pro) is the band whose warm default IS DEFAULT_WARM_TTL_SECONDS, so
  // placement keeps being tested against the 24 h window it has always used —
  // the storage tier (tiers.ts) now picks that default per account.
  const mk = (config?: { warmTtlSeconds?: number }, accountTier = 2) =>
    repo.createWorkspace({
      userId: 'user-1',
      accountTier,
      name: `pl-${Math.random().toString(36).slice(2)}`,
      ...(config ? { config } : {}),
    });

  it.skipIf(!available)('follows a warm pin whose node still has a worker', async () => {
    const ws = await mk();
    await repo.setWorkspaceNode(ws.workspaceId, WARM, new Date(Date.now() + 3600_000));
    const { queue, jobs, probes } = fakeQueue({ spawn: spawnOk(WARM) });

    await acquireWorkspace(db!, { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' }, { queue, environments: gateway });

    expect(jobs[0].queueName).toBe(workspaceNodeQueue(WARM));
    // The liveness probe asks about that node's queue, not the global one.
    expect(probes).toEqual([workspaceNodeQueue(WARM)]);
  });

  it.skipIf(!available)('drops an expired pin to the global queue, then re-pins from the node that took it', async () => {
    const ws = await mk();
    await repo.setWorkspaceNode(ws.workspaceId, WARM, new Date(Date.now() - 60_000));
    const { queue, jobs, probes } = fakeQueue({ spawn: spawnOk(OTHER) });

    await acquireWorkspace(db!, { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' }, { queue, environments: gateway });

    expect(jobs[0].queueName).toBe(WORKSPACE_QUEUE);
    // An expired pin is settled before anything touches Redis.
    expect(probes).toEqual([]);

    const doc = await repo.getWorkspace(ws.workspaceId);
    expect(doc!.nodeId).toBe(OTHER);
    expect(pinSeconds(doc!.nodePinnedUntil)).toBeGreaterThan(DEFAULT_WARM_TTL_SECONDS - 60);
  });

  it.skipIf(!available)('will not pin to a node with no live worker, even inside the warm window', async () => {
    const ws = await mk();
    await repo.setWorkspaceNode(ws.workspaceId, WARM, new Date(Date.now() + 3600_000));
    const { queue, jobs, probes } = fakeQueue({ spawn: spawnOk(OTHER) }, () => false);

    await acquireWorkspace(db!, { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' }, { queue, environments: gateway });

    expect(probes).toEqual([workspaceNodeQueue(WARM)]);
    expect(jobs[0].queueName).toBe(WORKSPACE_QUEUE);

    const doc = await repo.getWorkspace(ws.workspaceId);
    expect(doc!.nodeId).toBe(OTHER);
  });

  it.skipIf(!available)('honours a legacy pin that carries no warm window', async () => {
    const ws = await mk();
    // Written before `nodePinnedUntil` existed: nodeId and nothing else.
    await db!
      .collection('agentWorkspaces')
      .updateOne({ workspaceId: ws.workspaceId }, { $set: { nodeId: WARM }, $unset: { nodePinnedUntil: '' } });
    const { queue, jobs } = fakeQueue({ spawn: spawnOk(WARM) });

    await acquireWorkspace(db!, { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' }, { queue, environments: gateway });

    expect(jobs[0].queueName).toBe(workspaceNodeQueue(WARM));
  });

  it.skipIf(!available)('sends an explicit nodeId to that node regardless of the pin or the workers', async () => {
    const ws = await mk();
    await repo.setWorkspaceNode(ws.workspaceId, WARM, new Date(Date.now() - 60_000));
    const { queue, jobs, probes } = fakeQueue({ spawn: spawnOk('10.100.0.9') }, () => false);

    await acquireWorkspace(
      db!,
      { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1', nodeId: '10.100.0.9' },
      { queue, environments: gateway }
    );

    expect(jobs[0].queueName).toBe(workspaceNodeQueue('10.100.0.9'));
    // The caller owns the pin: nothing is checked on its behalf.
    expect(probes).toEqual([]);
  });

  it.skipIf(!available)('clears the pin when the release removed the volume', async () => {
    const ws = await mk();
    const { queue } = fakeQueue({
      spawn: spawnOk(OTHER),
      snapshot: { ok: true, snapshotId: 'snap-1', snapshotSizeBytes: 1, fileCount: 1, durationSeconds: 2, volumeRemoved: true },
    });

    const session = await acquireWorkspace(
      db!,
      { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' },
      { queue, environments: gateway }
    );
    expect((await repo.getWorkspace(ws.workspaceId))!.nodeId).toBe(OTHER);

    await session.release();

    const doc = await repo.getWorkspace(ws.workspaceId);
    expect(doc!.nodeId).toBeUndefined();
    expect(doc!.nodePinnedUntil).toBeUndefined();
    expect(doc!.activeCheckouts).toHaveLength(0);
  });

  it.skipIf(!available)('refreshes the pin when the release kept the volume, and treats a missing flag as kept', async () => {
    const kept = await mk();
    const { queue } = fakeQueue({
      spawn: spawnOk(OTHER),
      snapshot: { ok: true, snapshotId: 'snap-2', snapshotSizeBytes: 1, fileCount: 1, durationSeconds: 2, volumeRemoved: false, keptReason: 'dirty' },
    });
    const session = await acquireWorkspace(
      db!,
      { workspaceId: kept.workspaceId, runId: 'R1', workerId: 'w1' },
      { queue, environments: gateway }
    );
    await session.release();

    const doc = await repo.getWorkspace(kept.workspaceId);
    expect(doc!.nodeId).toBe(OTHER);
    expect(pinSeconds(doc!.nodePinnedUntil)).toBeGreaterThan(DEFAULT_WARM_TTL_SECONDS - 60);
    expect(pinSeconds(doc!.nodePinnedUntil)).toBeLessThanOrEqual(DEFAULT_WARM_TTL_SECONDS);

    // A worker that predates the field says nothing; the volume is still there.
    const silent = await mk();
    const { queue: q2 } = fakeQueue({ spawn: spawnOk(OTHER), snapshot: { ok: true, snapshotId: 'snap-3' } });
    const s2 = await acquireWorkspace(
      db!,
      { workspaceId: silent.workspaceId, runId: 'R2', workerId: 'w1' },
      { queue: q2, environments: gateway }
    );
    await s2.release();

    const doc2 = await repo.getWorkspace(silent.workspaceId);
    expect(doc2!.nodeId).toBe(OTHER);
    expect(pinSeconds(doc2!.nodePinnedUntil)).toBeGreaterThan(DEFAULT_WARM_TTL_SECONDS - 60);
  });

  it.skipIf(!available)('takes the warm window from the workspace config, defaulting to 24 h', async () => {
    expect(DEFAULT_WARM_TTL_SECONDS).toBe(86400);

    const short = await mk({ warmTtlSeconds: 60 });
    expect(short.config.warmTtlSeconds).toBe(60);
    const { queue } = fakeQueue({ spawn: spawnOk(OTHER) });
    await acquireWorkspace(db!, { workspaceId: short.workspaceId, runId: 'R1', workerId: 'w1' }, { queue, environments: gateway });

    const doc = await repo.getWorkspace(short.workspaceId);
    expect(pinSeconds(doc!.nodePinnedUntil)).toBeGreaterThan(0);
    expect(pinSeconds(doc!.nodePinnedUntil)).toBeLessThanOrEqual(60);

    // An unconfigured workspace gets the default, both stored and applied.
    const plain = await mk();
    expect(plain.config.warmTtlSeconds).toBe(DEFAULT_WARM_TTL_SECONDS);
    const { queue: q2 } = fakeQueue({ spawn: spawnOk(OTHER) });
    await acquireWorkspace(db!, { workspaceId: plain.workspaceId, runId: 'R2', workerId: 'w1' }, { queue: q2, environments: gateway });
    const doc2 = await repo.getWorkspace(plain.workspaceId);
    expect(pinSeconds(doc2!.nodePinnedUntil)).toBeGreaterThan(DEFAULT_WARM_TTL_SECONDS - 60);
  });
});
