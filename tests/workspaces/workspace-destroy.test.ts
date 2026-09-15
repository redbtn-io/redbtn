/**
 * Deleting a workspace has to clean up the fleet, not just the document.
 *
 * These run against an in-memory `agentWorkspaces` collection with the queue
 * injected: what matters here is WHICH nodes get a destroy job, which one of
 * them is told to purge the shared restic repository, and that the document is
 * only removed once those jobs exist. No Mongo, no Redis.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  destroyWorkspace,
  WorkspaceBusyError,
  nodeIdsFromWorkspace,
  liveCheckoutIds,
  ANY_WORKSPACE_NODE,
  WORKSPACE_QUEUE,
  workspaceNodeQueue,
  type IWorkspace,
  type LifecycleQueue,
} from '../../src/lib/workspaces';

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const now = () => NOW;

type Op =
  | { op: 'findOne' }
  | { op: 'updateOne'; set: Record<string, unknown> }
  | { op: 'deleteOne' }
  | { op: 'enqueue'; queueName: string; data: Record<string, unknown> };

/** The slice of the driver `destroyWorkspace` uses, over one document. */
function fakeDb(doc: IWarmWorkspace | null) {
  const ops: Op[] = [];
  let stored = doc;
  const db = {
    collection() {
      return {
        async findOne() {
          ops.push({ op: 'findOne' });
          return stored;
        },
        async updateOne(_filter: unknown, update: { $set?: Record<string, unknown> }) {
          ops.push({ op: 'updateOne', set: update.$set ?? {} });
          if (stored) stored = { ...stored, ...(update.$set as object) } as IWarmWorkspace;
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async deleteOne() {
          ops.push({ op: 'deleteOne' });
          const existed = stored !== null;
          stored = null;
          return { deletedCount: existed ? 1 : 0 };
        },
      };
    },
  };
  return { db: db as never, ops, current: () => stored };
}

function fakeQueue(opts: { discovered?: string[]; workers?: Record<string, boolean>; failOn?: string[] } = {}) {
  const enqueued: Array<{ queueName: string; jobName: string; data: Record<string, unknown> }> = [];
  const queue: LifecycleQueue = {
    async runJob() {
      throw new Error('destroy must not block on runJob');
    },
    async enqueue(queueName, jobName, data) {
      if (opts.failOn?.includes(queueName)) throw new Error(`queue ${queueName} is unreachable`);
      enqueued.push({ queueName, jobName, data });
    },
    async listNodeQueues() {
      return opts.discovered ?? [];
    },
    async hasWorkers(queueName) {
      return opts.workers?.[queueName] ?? false;
    },
  };
  return { queue, enqueued };
}

/** `stats.warmVolumes` is written by the workers' storage sampler. */
type IWarmWorkspace = IWorkspace & { stats: IWorkspace['stats'] & { warmVolumes?: Array<{ nodeId: string }> } };

function workspaceDoc(overrides: Partial<IWarmWorkspace> = {}): IWarmWorkspace {
  return {
    workspaceId: 'ws_abc123',
    userId: 'user-1',
    name: 'Zeta',
    resticRepository: 's3:http://minio:9000/workspaces/ws_abc123',
    currentSnapshotId: null,
    config: { dockerImage: 'workspace-runner:latest', cpuLimit: '2.0', memLimit: '4096m', defaultCwd: '/workspace' },
    stats: { snapshotSizeBytes: 0, lastSnapshotAt: null, fileCount: 0, totalRunCount: 0, totalComputeSeconds: 0 },
    version: 3,
    maxConcurrentCheckouts: 8,
    activeCheckouts: [],
    createdAt: new Date(NOW - 86_400_000),
    updatedAt: new Date(NOW - 3_600_000),
    ...overrides,
  } as IWarmWorkspace;
}

function checkout(overrides: Partial<IWorkspace['activeCheckouts'][number]> = {}) {
  return {
    checkoutId: 'chk_live',
    checkoutKey: 'trunk',
    mode: 'exclusive' as const,
    branch: 'main',
    runId: 'run-1',
    workerId: 'w1',
    environmentId: 'env_x',
    installId: 'ws_ws_abc123_chk_live',
    volumeName: 'ws_abc123_data',
    leaseExpiresAt: new Date(NOW + 60_000),
    createdAt: new Date(NOW - 60_000),
    ...overrides,
  };
}

describe('destroyWorkspace', () => {
  it('refuses a workspace with live checkouts and names them', async () => {
    const { db, ops } = fakeDb(
      workspaceDoc({
        activeCheckouts: [
          checkout({ checkoutId: 'chk_one' }),
          checkout({ checkoutId: 'chk_two', checkoutKey: 'card-101', mode: 'branch' }),
          // Expired: an abandoned run must not make a workspace undeletable.
          checkout({ checkoutId: 'chk_dead', leaseExpiresAt: new Date(NOW - 1000) }),
        ],
      }),
    );
    const { queue, enqueued } = fakeQueue();

    await expect(destroyWorkspace(db, 'ws_abc123', {}, { queue, now })).rejects.toMatchObject({
      name: 'WorkspaceBusyError',
      code: 'WORKSPACE_BUSY',
      checkouts: ['chk_one', 'chk_two'],
    });

    // Nothing was touched: no status flip, no jobs, and above all no delete.
    expect(enqueued).toHaveLength(0);
    expect(ops.map((o) => o.op)).toEqual(['findOne']);
  });

  it('fans out to the pinned, parked, checkout and warm-volume nodes, deduped', async () => {
    const { db } = fakeDb(
      workspaceDoc({
        nodeId: '10.100.0.5',
        parkedCheckout: {
          checkoutId: 'chk_parked',
          installId: 'i',
          environmentId: 'env_p',
          containerName: 'ws_abc123_chk_parked',
          nodeId: '10.100.0.7',
          parkedUntil: new Date(NOW - 1000),
        },
        // Expired lease, so it does not block the delete — but the node it bound
        // to still holds the container, so it is still a destroy target.
        activeCheckouts: [checkout({ checkoutId: 'chk_dead', nodeId: '10.100.0.8', leaseExpiresAt: new Date(NOW - 1) })],
        stats: {
          ...workspaceDoc().stats,
          warmVolumes: [{ nodeId: '10.100.0.5' }, { nodeId: '10.100.0.9' }],
        },
      }),
    );
    const { queue, enqueued } = fakeQueue();

    const result = await destroyWorkspace(db, 'ws_abc123', { requestedBy: 'user-1' }, { queue, now });

    expect(result).toEqual({
      deleted: true,
      jobsEnqueued: ['10.100.0.5', '10.100.0.7', '10.100.0.8', '10.100.0.9'],
    });
    expect(enqueued.map((job) => job.queueName)).toEqual([
      workspaceNodeQueue('10.100.0.5'),
      workspaceNodeQueue('10.100.0.7'),
      workspaceNodeQueue('10.100.0.8'),
      workspaceNodeQueue('10.100.0.9'),
    ]);
    for (const job of enqueued) {
      expect(job.jobName).toBe('destroy');
      expect(job.data).toMatchObject({ action: 'destroy', workspaceId: 'ws_abc123', userId: 'user-1' });
    }
  });

  it('asks exactly one node to purge the snapshots', async () => {
    const { db } = fakeDb(
      workspaceDoc({
        nodeId: '10.100.0.5',
        stats: { ...workspaceDoc().stats, warmVolumes: [{ nodeId: '10.100.0.7' }, { nodeId: '10.100.0.9' }] },
      }),
    );
    const { queue, enqueued } = fakeQueue();

    await destroyWorkspace(db, 'ws_abc123', {}, { queue, now });

    const purging = enqueued.filter((job) => job.data.purgeSnapshots === true);
    expect(purging).toHaveLength(1);
    // The restic repository is per-workspace shared object storage: the first
    // node reached owns the purge, the rest are told not to.
    expect(purging[0].queueName).toBe(workspaceNodeQueue('10.100.0.5'));
    expect(enqueued.filter((job) => job.data.purgeSnapshots === false)).toHaveLength(2);
  });

  it('flips the document to deleting BEFORE enqueueing, and deletes it after', async () => {
    const { db, ops, current } = fakeDb(workspaceDoc({ nodeId: '10.100.0.5' }));
    const order: string[] = [];
    const queue: LifecycleQueue = {
      async runJob() {
        throw new Error('unused');
      },
      async enqueue() {
        order.push('enqueue');
      },
    };

    const result = await destroyWorkspace(db, 'ws_abc123', { requestedBy: 'user-1' }, { queue, now });

    const sequence = ops.map((o) => o.op);
    expect(sequence).toEqual(['findOne', 'updateOne', 'deleteOne']);
    const marked = ops.find((o) => o.op === 'updateOne') as Extract<Op, { op: 'updateOne' }>;
    expect(marked.set.status).toBe('deleting');
    expect(marked.set.deletionRequestedBy).toBe('user-1');
    // The status write lands before the job, and the delete after it.
    expect(sequence.indexOf('updateOne')).toBeLessThan(sequence.indexOf('deleteOne'));
    expect(order).toEqual(['enqueue']);
    expect(current()).toBeNull();
    expect(result.deleted).toBe(true);
  });

  it('is idempotent when the document is already gone', async () => {
    const { db, ops } = fakeDb(null);
    const { queue, enqueued } = fakeQueue();

    const result = await destroyWorkspace(db, 'ws_gone', {}, { queue, now });

    expect(result).toEqual({ deleted: false, jobsEnqueued: [] });
    expect(enqueued).toHaveLength(0);
    expect(ops.map((o) => o.op)).toEqual(['findOne']);
  });

  it('falls back to every discovered queue with a live worker, then to the global queue', async () => {
    const withWorkers = fakeQueue({
      discovered: [workspaceNodeQueue('10.100.0.5'), workspaceNodeQueue('10.100.0.9')],
      workers: { [workspaceNodeQueue('10.100.0.5')]: true, [workspaceNodeQueue('10.100.0.9')]: false },
    });
    const a = fakeDb(workspaceDoc());
    const discovered = await destroyWorkspace(a.db, 'ws_abc123', {}, { queue: withWorkers.queue, now });
    expect(discovered.jobsEnqueued).toEqual(['10.100.0.5']);
    expect(withWorkers.enqueued[0].data.purgeSnapshots).toBe(true);

    // Nothing recorded and nothing discovered: the global queue still reaches a
    // node, and the snapshots are the one thing no reaper would ever remove.
    const none = fakeQueue();
    const b = fakeDb(workspaceDoc());
    const global = await destroyWorkspace(b.db, 'ws_abc123', {}, { queue: none.queue, now });
    expect(global.jobsEnqueued).toEqual([ANY_WORKSPACE_NODE]);
    expect(none.enqueued[0].queueName).toBe(WORKSPACE_QUEUE);
    expect(none.enqueued[0].data.purgeSnapshots).toBe(true);
  });

  it('deletes the document even when a node queue cannot be reached, and moves the purge on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, current } = fakeDb(
      workspaceDoc({ nodeId: '10.100.0.5', stats: { ...workspaceDoc().stats, warmVolumes: [{ nodeId: '10.100.0.7' }] } }),
    );
    const { queue, enqueued } = fakeQueue({ failOn: [workspaceNodeQueue('10.100.0.5')] });

    const result = await destroyWorkspace(db, 'ws_abc123', {}, { queue, now });

    expect(result).toEqual({ deleted: true, jobsEnqueued: ['10.100.0.7'] });
    // The purge was assigned to the first job that was actually accepted.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].data.purgeSnapshots).toBe(true);
    expect(current()).toBeNull();
    warn.mockRestore();
  });
});

describe('destroy target selection', () => {
  it('counts only unexpired checkouts as live', () => {
    const doc = workspaceDoc({
      activeCheckouts: [
        checkout({ checkoutId: 'chk_live', leaseExpiresAt: new Date(NOW + 1) }),
        checkout({ checkoutId: 'chk_expired', leaseExpiresAt: new Date(NOW - 1) }),
      ],
    });
    expect(liveCheckoutIds(doc, NOW)).toEqual(['chk_live']);
  });

  it('keeps the pin first and drops blanks and duplicates', () => {
    const doc = workspaceDoc({
      nodeId: '10.100.0.5',
      stats: { ...workspaceDoc().stats, warmVolumes: [{ nodeId: '  ' as string }, { nodeId: '10.100.0.5' }] },
    });
    expect(nodeIdsFromWorkspace(doc, ['10.100.0.9', '10.100.0.5'])).toEqual(['10.100.0.5', '10.100.0.9']);
  });
});
