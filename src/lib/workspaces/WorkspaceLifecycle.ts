/**
 * The workspace PRODUCER.
 *
 * Everything under src/lib/workspaces existed with zero non-test callers: the
 * redrun worker listened on `workspace-lifecycle` and nothing ever enqueued a
 * job, so the "consumer half" shipped and the subsystem never ran (48a). This is
 * the missing half.
 *
 *   acquire()  checkout (CAS)  →  enqueue workspace.spawn  →  wait for the
 *              container to REGISTER  →  adopt the environmentId the GATEWAY
 *              assigned  →  start renewing the lease
 *   release()  stop renewing  →  enqueue workspace.snapshot on the node that
 *              holds the volume  →  release the checkout
 *
 * The engine never touches the docker socket. It talks to the per-node redrun
 * worker over BullMQ, which is the one process on each node that already holds
 * /var/run/docker.sock.
 */
import type { Db } from 'mongodb';
import { WorkspaceRepository } from './WorkspaceRepository.js';
import { createWorkspaceRegistrationToken } from './workspace-token.js';
import type { IWorkspace, IWorkspaceCheckout, CheckoutMode } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Queue: BullQueue } = require('bullmq');

export const WORKSPACE_QUEUE = 'workspace-lifecycle';
/** Snapshot/reap must return to the node that holds the container and volume. */
export const workspaceNodeQueue = (nodeId: string) => `${WORKSPACE_QUEUE}--${nodeId}`;

/** Longer than a CLI step's realistic runtime, and renewed while the step runs. */
export const DEFAULT_LEASE_MS = 30 * 60 * 1000;
export const LEASE_RENEW_INTERVAL_MS = 60 * 1000;
const SPAWN_TIMEOUT_MS = 5 * 60 * 1000;
const REGISTER_TIMEOUT_MS = 3 * 60 * 1000;
const SNAPSHOT_TIMEOUT_MS = 15 * 60 * 1000;

export class WorkspaceSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSpawnError';
  }
}

function connectionFromEnv(): { host: string; port: number; password?: string; username?: string; db?: number; tls?: object } {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  try {
    const parsed = new URL(url);
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const db = parsed.pathname && parsed.pathname !== '/' ? parseInt(parsed.pathname.slice(1), 10) : 0;
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      ...(password && { password }),
      ...(username && { username }),
      ...(db && { db }),
      ...(parsed.protocol === 'rediss:' && { tls: {} }),
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

const queues = new Map<string, any>();
function getQueue(name: string): any {
  const prefix = process.env.BULLMQ_PREFIX ?? 'bull';
  const key = `${prefix}:${name}`;
  if (!queues.has(key)) {
    queues.set(key, new BullQueue(name, { connection: connectionFromEnv(), prefix }));
  }
  return queues.get(key);
}

/** Injectable so tests never need Redis. */
export interface LifecycleQueue {
  runJob(queueName: string, jobName: string, data: Record<string, unknown>, timeoutMs: number): Promise<any>;
}

export const bullLifecycleQueue: LifecycleQueue = {
  async runJob(queueName, jobName, data, timeoutMs) {
    const queue = getQueue(queueName);
    const job = await queue.add(jobName, data, {
      removeOnComplete: 200,
      removeOnFail: 500,
      attempts: 1,
    });
    const started = Date.now();
    // Poll rather than QueueEvents: one short-lived listener per spawn is a
    // connection per run, and the poll is bounded by the same timeout.
    for (;;) {
      const state = await job.getState();
      if (state === 'completed') return await job.returnvalue ?? (await queue.getJob(job.id!))?.returnvalue;
      if (state === 'failed') {
        const failed = await queue.getJob(job.id!);
        throw new WorkspaceSpawnError(
          `${jobName} failed on ${queueName}: ${failed?.failedReason || 'unknown reason'}`
        );
      }
      if (Date.now() - started > timeoutMs) {
        throw new WorkspaceSpawnError(`${jobName} on ${queueName} did not complete within ${timeoutMs}ms (state: ${state})`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  },
};

/** The Environment the GATEWAY created when the runner registered. */
export interface EnvironmentLookup {
  findByInstallId(userId: string, installId: string): Promise<{ environmentId: string } | null>;
}

export function mongoEnvironmentLookup(db: Db): EnvironmentLookup {
  return {
    async findByInstallId(userId, installId) {
      const doc = await db
        .collection('environments')
        .findOne(
          { userId, installId },
          { projection: { environmentId: 1 }, maxTimeMS: 5000 }
        );
      return doc?.environmentId ? { environmentId: doc.environmentId as string } : null;
    },
  };
}

export interface AcquireOptions {
  workspaceId: string;
  runId: string;
  workerId: string;
  checkoutKey?: string;
  mode?: CheckoutMode;
  leaseDurationMs?: number;
  apiUrl?: string;
  /**
   * Pin the spawn to one node's queue. Defaults to the node that last spawned
   * this workspace (recorded on the document): the named volume lives there, so
   * going back to it reuses the working copy instead of restoring the whole
   * repository from object storage. Falls back to the global queue, where any
   * provisioned node may take the job.
   */
  nodeId?: string;
}

export interface AcquiredWorkspace {
  workspace: IWorkspace;
  checkout: IWorkspaceCheckout;
  /** The environmentId the gateway assigned. NOT the one minted at checkout. */
  environmentId: string;
  nodeId: string;
  containerName: string;
  volumeName: string;
}

export class WorkspaceSession {
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private released = false;

  constructor(
    private readonly repo: WorkspaceRepository,
    readonly acquired: AcquiredWorkspace,
    private readonly queue: LifecycleQueue,
    private readonly leaseDurationMs: number
  ) {}

  get environmentId(): string {
    return this.acquired.environmentId;
  }

  /**
   * Renew the lease while the step runs. Without this a 40-minute run's lease
   * expired at minute 15 and the reaper could reclaim a workspace someone was
   * still writing to (48a M5).
   */
  startRenewing(onLost?: (err: Error) => void): void {
    if (this.renewTimer) return;
    const { workspace, checkout } = this.acquired;
    this.renewTimer = setInterval(() => {
      this.repo
        .renewWorkspaceLease(workspace.workspaceId, checkout.checkoutId, checkout.runId, this.leaseDurationMs)
        .catch((err: Error) => {
          console.warn('[WorkspaceSession] lease renewal failed:', err.message);
          onLost?.(err);
        });
    }, LEASE_RENEW_INTERVAL_MS);
    // Never hold the event loop open on the renewal alone.
    (this.renewTimer as any).unref?.();
  }

  stopRenewing(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }

  /**
   * Snapshot and release. Idempotent: a second call is a no-op, so a `finally`
   * and an explicit release cannot double-release.
   */
  async release(options: { skipSnapshot?: boolean; computeSeconds?: number } = {}): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopRenewing();

    const { workspace, checkout, nodeId } = this.acquired;
    let snapshotMeta:
      | { snapshotId: string; snapshotSizeBytes: number; fileCount: number; computeSeconds: number }
      | undefined;

    try {
      const result = await this.queue.runJob(
        workspaceNodeQueue(nodeId),
        'snapshot',
        {
          action: 'snapshot',
          workspaceId: workspace.workspaceId,
          checkoutId: checkout.checkoutId,
          mode: checkout.mode,
          checkoutKey: checkout.checkoutKey,
          skipSnapshot: options.skipSnapshot ?? false,
          removeVolume: checkout.mode === 'branch',
        },
        SNAPSHOT_TIMEOUT_MS
      );
      if (result?.snapshotId) {
        snapshotMeta = {
          snapshotId: result.snapshotId,
          snapshotSizeBytes: result.snapshotSizeBytes ?? 0,
          fileCount: result.fileCount ?? 0,
          computeSeconds: options.computeSeconds ?? result.durationSeconds ?? 0,
        };
      }
    } catch (err) {
      // The checkout MUST still be released, or the workspace stays locked for
      // every future run. Snapshot failure is loud but not fatal to the lock.
      console.error('[WorkspaceSession] snapshot failed; releasing the checkout anyway:', err);
    }

    await this.repo.releaseWorkspace({
      workspaceId: workspace.workspaceId,
      checkoutId: checkout.checkoutId,
      runId: checkout.runId,
      expectedVersion: workspace.version,
      commitTrunkSnapshot: !!snapshotMeta,
      snapshotMeta,
    });
  }
}

/**
 * Check out a workspace and bring its container up.
 *
 * Fails closed at every step: a failed spawn, a container that never registers,
 * or an isolation-probe breach all leave the checkout RELEASED rather than a
 * half-acquired workspace nobody can use.
 */
export async function acquireWorkspace(
  db: Db,
  options: AcquireOptions,
  deps: {
    queue?: LifecycleQueue;
    environments?: EnvironmentLookup;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<WorkspaceSession> {
  const queue = deps.queue ?? bullLifecycleQueue;
  const environments = deps.environments ?? mongoEnvironmentLookup(db);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  const repo = new WorkspaceRepository(db);
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS;

  const { workspace, checkout } = await repo.checkoutWorkspace({
    workspaceId: options.workspaceId,
    runId: options.runId,
    workerId: options.workerId,
    checkoutKey: options.checkoutKey,
    mode: options.mode,
    leaseDurationMs,
  });

  const rregToken = createWorkspaceRegistrationToken({
    workspaceId: workspace.workspaceId,
    checkoutId: checkout.checkoutId,
    installId: checkout.installId,
    userId: workspace.userId,
    ttlSeconds: Math.ceil(leaseDurationMs / 1000) * 4,
  });

  try {
    const targetNode = options.nodeId || (workspace as any).nodeId;
    const spawnQueue = targetNode ? workspaceNodeQueue(targetNode) : WORKSPACE_QUEUE;
    const spawn = await queue.runJob(
      spawnQueue,
      'spawn',
      {
        action: 'spawn',
        workspaceId: workspace.workspaceId,
        checkoutId: checkout.checkoutId,
        installId: checkout.installId,
        rregToken,
        mode: checkout.mode,
        checkoutKey: checkout.checkoutKey,
        branch: checkout.branch,
        apiUrl: options.apiUrl ?? process.env.WEBAPP_PUBLIC_URL ?? 'https://app.redbtn.io',
        gitRepoUrl: workspace.config?.gitRepoUrl,
        gitBranch: workspace.config?.gitBranch,
        ownerUserId: workspace.userId,
        dockerImage: workspace.config?.dockerImage,
        cpuLimit: workspace.config?.cpuLimit,
        memLimit: workspace.config?.memLimit,
      },
      SPAWN_TIMEOUT_MS
    );

    if (!spawn?.ok || !spawn?.nodeId) {
      throw new WorkspaceSpawnError(
        `Workspace spawn for ${workspace.workspaceId} returned no node (${JSON.stringify(spawn)})`
      );
    }

    // Adopt the environmentId the GATEWAY assigned on register.
    // The checkout mints one locally and the gateway independently upserts its
    // own on (userId, installId, kind); nothing reconciled them, so every bridge
    // call targeted an environment that does not exist (48a P0-5).
    const deadline = now() + REGISTER_TIMEOUT_MS;
    let environmentId: string | null = null;
    while (now() < deadline) {
      const env = await environments.findByInstallId(workspace.userId, checkout.installId);
      if (env?.environmentId) {
        environmentId = env.environmentId;
        break;
      }
      await sleep(2000);
    }
    if (!environmentId) {
      throw new WorkspaceSpawnError(
        `Workspace container for ${workspace.workspaceId} never registered an environment for installId ${checkout.installId}`
      );
    }

    await repo.bindCheckoutRuntime(workspace.workspaceId, checkout.checkoutId, checkout.runId, {
      environmentId,
      nodeId: spawn.nodeId,
      containerName: spawn.containerName,
      volumeName: spawn.volumeName,
    });
    // Remember where the volume lives, so the next checkout goes back to it.
    await repo.setWorkspaceNode(workspace.workspaceId, spawn.nodeId).catch(() => {});

    const acquired: AcquiredWorkspace = {
      workspace,
      checkout: { ...checkout, environmentId },
      environmentId,
      nodeId: spawn.nodeId,
      containerName: spawn.containerName,
      volumeName: spawn.volumeName,
    };
    return new WorkspaceSession(repo, acquired, queue, leaseDurationMs);
  } catch (err) {
    // Nothing is running (the worker destroys the container on any spawn-side
    // failure), so give the slot straight back.
    await repo
      .releaseWorkspace({
        workspaceId: workspace.workspaceId,
        checkoutId: checkout.checkoutId,
        runId: checkout.runId,
        expectedVersion: workspace.version,
      })
      .catch(() => {});
    throw err;
  }
}
