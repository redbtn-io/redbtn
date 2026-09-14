/**
 * The producer: checkout → spawn job → adopt the gateway's environmentId →
 * renew → snapshot on the owning node → release.
 *
 * Runs against a real MongoDB (see workspace-repository.test.ts) with the BullMQ
 * queue and the environment lookup injected, so the whole acquire/release path
 * executes for real without Redis.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import {
  acquireWorkspace,
  WorkspaceRepository,
  WorkspaceSpawnError,
  WORKSPACE_QUEUE,
  workspaceNodeQueue,
  verifyWorkspaceRegistrationToken,
  type LifecycleQueue,
} from '../../src/lib/workspaces';

const URI = process.env.WORKSPACE_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = `workspace_producer_test_${Date.now()}`;

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

function fakeQueue(results: Record<string, any>, failures: Record<string, string> = {}) {
  const jobs: Enqueued[] = [];
  const queue: LifecycleQueue = {
    async runJob(queueName, jobName, data) {
      jobs.push({ queueName, jobName, data });
      if (failures[jobName]) throw new WorkspaceSpawnError(failures[jobName]);
      return results[jobName];
    },
  };
  return { queue, jobs };
}

const SPAWN_OK = {
  ok: true,
  containerName: 'ws_abc_chk1',
  volumeName: 'ws_abc_data',
  installId: 'x',
  nodeId: '10.100.0.5',
};

describe('acquireWorkspace (producer)', () => {
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

  const mk = () => repo.createWorkspace({ userId: 'user-1', name: `p-${Math.random().toString(36).slice(2)}` } as any);

  it.skipIf(!available)('enqueues a spawn carrying an rreg_ token bound to THIS checkout and no other secret', async () => {
    const ws = await mk();
    const { queue, jobs } = fakeQueue({ spawn: SPAWN_OK });

    const session = await acquireWorkspace(
      db!,
      { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' },
      { queue, environments: { findByInstallId: async () => ({ environmentId: 'env_gatewayAssigned' }) } }
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0].queueName).toBe(WORKSPACE_QUEUE);
    expect(jobs[0].jobName).toBe('spawn');

    const token = jobs[0].data.rregToken as string;
    const claims = verifyWorkspaceRegistrationToken(token)!;
    expect(claims).toBeTruthy();
    expect(claims.workspaceId).toBe(ws.workspaceId);
    expect(claims.userId).toBe('user-1');
    expect(claims.installId).toBe(jobs[0].data.installId);
    expect(claims.checkoutId).toBe(session.acquired.checkout.checkoutId);
    // TTL must outlive the lease, or a reconnect kills a still-leased run.
    expect(claims.exp - claims.iat).toBeGreaterThan(30 * 60);

    // Nothing in the job data is a storage credential: restic and MinIO live in
    // the node's own environment, never in a job a producer composes.
    const keys = Object.keys(jobs[0].data);
    expect(keys).not.toContain('resticRepository');
    expect(keys).not.toContain('resticPassword');
    expect(JSON.stringify(jobs[0].data)).not.toMatch(/AWS_|MINIO|RESTIC/);
  });

  it.skipIf(!available)('adopts the environmentId the GATEWAY assigned, not the one minted at checkout', async () => {
    const ws = await mk();
    const { queue } = fakeQueue({ spawn: SPAWN_OK });

    const before = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'probe', workerId: 'w', checkoutKey: 'probe' });
    const mintedShape = before.checkout.environmentId;
    await repo.releaseWorkspace({ workspaceId: ws.workspaceId, checkoutId: before.checkout.checkoutId, runId: 'probe' });

    const session = await acquireWorkspace(
      db!,
      { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' },
      { queue, environments: { findByInstallId: async () => ({ environmentId: 'env_gatewayAssigned' }) } }
    );

    expect(session.environmentId).toBe('env_gatewayAssigned');
    expect(session.environmentId).not.toBe(mintedShape);

    const doc = await repo.getWorkspace(ws.workspaceId);
    const mine = doc!.activeCheckouts.find((c) => c.runId === 'R1')!;
    expect(mine.environmentId).toBe('env_gatewayAssigned');
    expect(mine.nodeId).toBe('10.100.0.5');
  });

  it.skipIf(!available)('releases the checkout when the spawn fails, so the workspace is not left locked', async () => {
    const ws = await mk();
    const { queue } = fakeQueue({}, { spawn: 'isolation is NOT in force' });

    await expect(
      acquireWorkspace(db!, { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' }, { queue })
    ).rejects.toThrow(/isolation is NOT in force/);

    const doc = await repo.getWorkspace(ws.workspaceId);
    expect(doc!.activeCheckouts).toHaveLength(0);

    // …and the workspace is immediately usable again.
    const { queue: q2 } = fakeQueue({ spawn: SPAWN_OK });
    const ok = await acquireWorkspace(
      db!,
      { workspaceId: ws.workspaceId, runId: 'R2', workerId: 'w1' },
      { queue: q2, environments: { findByInstallId: async () => ({ environmentId: 'env_ok' }) } }
    );
    expect(ok.environmentId).toBe('env_ok');
  });

  it.skipIf(!available)('releases the checkout when the container never registers', async () => {
    const ws = await mk();
    const { queue } = fakeQueue({ spawn: SPAWN_OK });
    let t = 0;

    await expect(
      acquireWorkspace(
        db!,
        { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' },
        {
          queue,
          environments: { findByInstallId: async () => null },
          now: () => (t += 60_000),
          sleep: async () => {},
        }
      )
    ).rejects.toThrow(/never registered an environment/);

    const doc = await repo.getWorkspace(ws.workspaceId);
    expect(doc!.activeCheckouts).toHaveLength(0);
  });

  it.skipIf(!available)('snapshots on the queue of the node that holds the volume, then releases', async () => {
    const ws = await mk();
    const { queue, jobs } = fakeQueue({
      spawn: SPAWN_OK,
      snapshot: { ok: true, snapshotId: 'snap-9', snapshotSizeBytes: 123, fileCount: 4, durationSeconds: 11, nodeId: '10.100.0.5' },
    });

    const session = await acquireWorkspace(
      db!,
      { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' },
      { queue, environments: { findByInstallId: async () => ({ environmentId: 'env_ok' }) } }
    );
    await session.release();

    const snap = jobs.find((j) => j.jobName === 'snapshot')!;
    expect(snap.queueName).toBe(workspaceNodeQueue('10.100.0.5'));
    expect(snap.queueName).not.toBe(WORKSPACE_QUEUE);
    expect(snap.data.skipSnapshot).toBe(false);

    const doc = await repo.getWorkspace(ws.workspaceId);
    expect(doc!.activeCheckouts).toHaveLength(0);
    expect(doc!.currentSnapshotId).toBe('snap-9');
    expect(doc!.stats.fileCount).toBe(4);
  });

  it.skipIf(!available)('still releases the checkout when the snapshot job fails', async () => {
    const ws = await mk();
    const { queue } = fakeQueue({ spawn: SPAWN_OK }, { snapshot: 'restic exploded' });
    const session = await acquireWorkspace(
      db!,
      { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' },
      { queue, environments: { findByInstallId: async () => ({ environmentId: 'env_ok' }) } }
    );

    await session.release();
    const doc = await repo.getWorkspace(ws.workspaceId);
    expect(doc!.activeCheckouts).toHaveLength(0);
    expect(doc!.currentSnapshotId).toBeNull();
  });

  it.skipIf(!available)('release is idempotent', async () => {
    const ws = await mk();
    const { queue, jobs } = fakeQueue({ spawn: SPAWN_OK, snapshot: { ok: true, snapshotId: 's', snapshotSizeBytes: 0, fileCount: 0, durationSeconds: 1 } });
    const session = await acquireWorkspace(
      db!,
      { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' },
      { queue, environments: { findByInstallId: async () => ({ environmentId: 'env_ok' }) } }
    );
    await session.release();
    await session.release();
    expect(jobs.filter((j) => j.jobName === 'snapshot')).toHaveLength(1);
  });

  it.skipIf(!available)('renews the lease while the session is held', async () => {
    vi.useFakeTimers();
    try {
      const ws = await mk();
      const { queue } = fakeQueue({ spawn: SPAWN_OK });
      const session = await acquireWorkspace(
        db!,
        { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' },
        { queue, environments: { findByInstallId: async () => ({ environmentId: 'env_ok' }) } }
      );

      const before = (await repo.getWorkspace(ws.workspaceId))!.activeCheckouts[0].leaseExpiresAt.getTime();
      session.startRenewing();
      await vi.advanceTimersByTimeAsync(61_000);
      session.stopRenewing();

      const after = (await repo.getWorkspace(ws.workspaceId))!.activeCheckouts[0].leaseExpiresAt.getTime();
      expect(after).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
