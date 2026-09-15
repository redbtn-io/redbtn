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
 * Three tiers of warmth, each the previous one's fallback: the CONTAINER
 * survives a release for `config.hotIdleSeconds` and the next acquire adopts it
 * (no start, no registration); the VOLUME survives for `config.warmTtlSeconds`
 * and the next acquire reuses the working copy on that node; the SNAPSHOT
 * survives everything and is restored from object storage anywhere.
 *
 * The engine never touches the docker socket. It talks to the per-node redrun
 * worker over BullMQ, which is the one process on each node that already holds
 * /var/run/docker.sock.
 */
import type { Db } from 'mongodb';
import { WorkspaceRepository, warmTtlSeconds, hotIdleSeconds } from './WorkspaceRepository.js';
import { createWorkspaceRegistrationToken } from './workspace-token.js';
import { resolveGithubInstallation } from './github-installations.js';
import type { IWorkspace, IWorkspaceCheckout, IParkedCheckout, CheckoutMode } from './types.js';

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
  /**
   * Whether any worker is consuming `queueName`. A node-scoped queue with no
   * consumer swallows the job until the spawn timeout, so placement asks before
   * it pins. Optional: a queue injected by an older caller cannot answer, and
   * an unanswerable probe keeps the pin rather than throwing warmth away.
   */
  hasWorkers?(queueName: string): Promise<boolean>;
  /**
   * Add a job and return. `runJob` waits for the result, which is right for a
   * spawn the caller cannot proceed without and wrong for fan-out work nobody
   * is waiting on (see workspace-destroy).
   */
  enqueue?(queueName: string, jobName: string, data: Record<string, unknown>): Promise<void>;
  /**
   * Every per-node workspace queue Redis knows about, discovered from the
   * BullMQ keyspace. The engine has no fleet registry of its own, so this is how
   * a fan-out finds nodes a workspace document never named.
   */
  listNodeQueues?(): Promise<string[]>;
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

  async hasWorkers(queueName) {
    try {
      const workers = await getQueue(queueName).getWorkers();
      return Array.isArray(workers) && workers.length > 0;
    } catch {
      // Could not prove a consumer exists; treat the node as gone. The global
      // queue always has one, and a cold restore beats a five-minute timeout.
      return false;
    }
  },

  async enqueue(queueName, jobName, data) {
    // Retried, unlike the jobs above: nothing is waiting on the result, so a
    // node that is briefly unreachable should be tried again rather than lost.
    await getQueue(queueName).add(jobName, data, {
      removeOnComplete: 200,
      removeOnFail: 500,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    });
  },

  async listNodeQueues() {
    const prefix = process.env.BULLMQ_PREFIX ?? 'bull';
    const pattern = `${prefix}:${WORKSPACE_QUEUE}--*:meta`;
    const found = new Set<string>();
    try {
      const client = await getQueue(WORKSPACE_QUEUE).client;
      let cursor = '0';
      do {
        const [next, keys]: [string, string[]] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        for (const key of keys) {
          const name = key.slice(prefix.length + 1, key.length - ':meta'.length);
          if (name.startsWith(`${WORKSPACE_QUEUE}--`)) found.add(name);
        }
      } while (cursor !== '0');
    } catch {
      // No Redis, or a keyspace this cannot walk. An empty list means "nothing
      // discovered", which every caller already has a fallback for.
      return [];
    }
    return [...found];
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
   * Pin the spawn to one node's queue, unconditionally. Left unset, placement
   * prefers the node that last spawned this workspace (recorded on the
   * document): the named volume lives there, so going back to it reuses the
   * working copy instead of restoring the whole repository from object storage.
   * That preference holds only while the pin is warm and the node still has a
   * worker — otherwise, and by default, the job goes to the global queue, where
   * any provisioned node may take it.
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
    // Above zero the node keeps the runner alive instead of destroying it, and
    // the next checkout adopts it. The environment id travels with the request
    // so an operator finding the marker knows what is registered in there.
    const idleSeconds = hotIdleSeconds(workspace.config);
    let snapshotMeta:
      | { snapshotId: string; snapshotSizeBytes: number; fileCount: number; computeSeconds: number }
      | undefined;
    // The node says whether it deleted the volume. Anything else — a worker
    // that predates the field, a snapshot that never came back — means it kept
    // it, and the working copy is still warm where it was.
    let volumeRemoved = false;
    // And whether it kept the runner alive. Only a node that says so parks one:
    // a park nobody confirmed would send the next acquire looking for a
    // container that does not exist.
    let parked = false;
    let parkedUntil: Date | null = null;

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
          ...(idleSeconds > 0
            ? { park: { idleSeconds, environmentId: this.acquired.environmentId } }
            : {}),
        },
        SNAPSHOT_TIMEOUT_MS
      );
      volumeRemoved = result?.volumeRemoved === true;
      parked = result?.parked === true;
      parkedUntil = typeof result?.parkedUntil === 'number' ? new Date(result.parkedUntil) : null;
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

    // The pin follows the warm data. A removed volume leaves nothing on that
    // node, so the workspace is cold and the next acquire places it fresh; a
    // kept one re-arms the warm window from now. Neither is worth failing the
    // release over — placement degrades to a cold spawn, nothing is lost.
    if (volumeRemoved) {
      await this.repo.clearWorkspaceNode(workspace.workspaceId).catch((err: Error) => {
        console.warn('[WorkspaceSession] could not clear the node pin:', err.message);
      });
    } else {
      const pinnedUntil = new Date(Date.now() + warmTtlSeconds(workspace.config) * 1000);
      await this.repo.setWorkspaceNode(workspace.workspaceId, nodeId, pinnedUntil).catch((err: Error) => {
        console.warn('[WorkspaceSession] could not refresh the node pin:', err.message);
      });
    }

    // The parked runner, if the node kept one. `clearWorkspaceNode` above
    // already dropped the record along with the volume, so this only has to
    // settle the case where the volume stayed and the container did not.
    if (parked && !volumeRemoved) {
      await this.repo
        .setParkedCheckout(workspace.workspaceId, {
          checkoutId: checkout.checkoutId,
          installId: checkout.installId,
          environmentId: this.acquired.environmentId,
          containerName: this.acquired.containerName,
          nodeId,
          parkedUntil: parkedUntil ?? new Date(Date.now() + idleSeconds * 1000),
        })
        .catch((err: Error) => {
          console.warn('[WorkspaceSession] could not record the parked runner:', err.message);
        });
    } else if (!volumeRemoved) {
      await this.repo.clearParkedCheckout(workspace.workspaceId).catch(() => {});
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
 * Where the spawn goes.
 *
 * An explicit `options.nodeId` is the caller's own pin and wins outright. The
 * workspace's recorded node is followed only while it is still worth following:
 * the pin has not aged out, and that node's queue still has a live consumer.
 * Nothing ever cleared `nodeId`, so a node that left the fleet kept every one
 * of its workspaces enqueueing spawns onto a queue no process reads, and each
 * run died at the five-minute spawn timeout instead of starting cold elsewhere.
 */
async function resolveSpawnQueue(
  queue: LifecycleQueue,
  workspace: IWorkspace,
  explicitNodeId: string | undefined,
  nowMs: number
): Promise<string> {
  if (explicitNodeId) return workspaceNodeQueue(explicitNodeId);

  const pinnedNode = workspace.nodeId;
  if (!pinnedNode) return WORKSPACE_QUEUE;

  // A record written before the warm window existed carries no expiry: honour
  // it, so nothing changes for an existing workspace until it releases once.
  const pinnedUntil = workspace.nodePinnedUntil ? new Date(workspace.nodePinnedUntil).getTime() : null;
  if (pinnedUntil !== null && pinnedUntil <= nowMs) {
    console.warn(`[acquireWorkspace] ${workspace.workspaceId}: pin expired; spawning on ${WORKSPACE_QUEUE}`);
    return WORKSPACE_QUEUE;
  }

  const nodeQueue = workspaceNodeQueue(pinnedNode);
  const live = queue.hasWorkers ? await queue.hasWorkers(nodeQueue) : true;
  if (!live) {
    console.warn(
      `[acquireWorkspace] ${workspace.workspaceId}: pinned node ${pinnedNode} has no live worker; spawning on ${WORKSPACE_QUEUE}`
    );
    return WORKSPACE_QUEUE;
  }
  return nodeQueue;
}

/**
 * The parked runner still worth going back to, or null.
 *
 * Expired is the same as absent: the node reaps a container the moment its park
 * window passes, so a stale record would only send the spawn to a node with
 * nothing warm on it and make the engine skip a registration wait it needs.
 */
function activeParkedCheckout(workspace: IWorkspace, nowMs: number): IParkedCheckout | null {
  const parked = workspace.parkedCheckout;
  if (!parked?.nodeId || !parked.installId) return null;
  const until = parked.parkedUntil ? new Date(parked.parkedUntil).getTime() : 0;
  return until > nowMs ? parked : null;
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
    const spawnQueue = await resolveSpawnQueue(queue, workspace, options.nodeId, now());
    // A parked runner only counts when the spawn is actually going to the node
    // holding it — the pin normally sends it there, but an explicit nodeId, an
    // aged pin or a dead worker can all send it elsewhere, and a container on
    // another node is no use to this checkout.
    const parked = activeParkedCheckout(workspace, now());
    const preferParked = !!parked && spawnQueue === workspaceNodeQueue(parked.nodeId);
    // Which App installation may clone this repository FOR THIS OWNER. A
    // branch-mode checkout starts from a fresh clone, so this is the job that
    // needs a token at all; the hub answers per-user, and a null — nothing
    // linked yet, or a hub that could not answer — leaves the worker on the
    // path it has always used (the owner's own secrets, then the allowlisted
    // platform fallback) and a public repository still clones anonymously.
    // Never fatal: a spawn is not a push.
    const githubInstallationId = workspace.config?.gitRepoUrl
      ? (await resolveGithubInstallation(workspace.userId, workspace.config.gitRepoUrl)).installationId
      : null;
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
        githubInstallationId,
        ...(preferParked ? { preferParked: true } : {}),
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

    // An adopted container was never restarted, so it is still registered under
    // the install id it was SPAWNED with — not the one minted for this checkout,
    // which belongs to a container that never existed. The node's id wins.
    const adopted = spawn.adopted === true && typeof spawn.installId === 'string' && !!spawn.installId;
    const installId = adopted ? (spawn.installId as string) : checkout.installId;

    // Adopt the environmentId the GATEWAY assigned on register.
    // The checkout mints one locally and the gateway independently upserts its
    // own on (userId, installId, kind); nothing reconciled them, so every bridge
    // call targeted an environment that does not exist (48a P0-5).
    // The one case with nothing to wait for is the container we parked
    // ourselves: its runner never disconnected, so the environment recorded
    // against that install id is still the live one.
    let environmentId: string | null =
      adopted && parked?.installId === installId ? parked.environmentId : null;
    const deadline = now() + REGISTER_TIMEOUT_MS;
    while (!environmentId && now() < deadline) {
      const env = await environments.findByInstallId(workspace.userId, installId);
      if (env?.environmentId) {
        environmentId = env.environmentId;
        break;
      }
      await sleep(2000);
    }
    if (!environmentId) {
      throw new WorkspaceSpawnError(
        `Workspace container for ${workspace.workspaceId} never registered an environment for installId ${installId}`
      );
    }

    await repo.bindCheckoutRuntime(workspace.workspaceId, checkout.checkoutId, checkout.runId, {
      environmentId,
      nodeId: spawn.nodeId,
      containerName: spawn.containerName,
      volumeName: spawn.volumeName,
      ...(adopted ? { installId } : {}),
    });
    // The park is spent either way: adopted, it is this checkout's container
    // now; not adopted, the node has already destroyed whatever was there. The
    // release re-establishes it if the workspace still runs a hot tier.
    if (workspace.parkedCheckout) await repo.clearParkedCheckout(workspace.workspaceId).catch(() => {});
    // Remember where the volume lives and for how long that is worth trusting,
    // so the next checkout goes back to it while it is still warm.
    const pinnedUntil = new Date(now() + warmTtlSeconds(workspace.config) * 1000);
    await repo.setWorkspaceNode(workspace.workspaceId, spawn.nodeId, pinnedUntil).catch(() => {});

    const acquired: AcquiredWorkspace = {
      workspace,
      checkout: { ...checkout, environmentId, installId },
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
