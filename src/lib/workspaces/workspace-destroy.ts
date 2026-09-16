/**
 * Deleting a workspace, for real.
 *
 * `deleteWorkspace` removed the Mongo document and nothing else, so every
 * deletion leaked the state the document was the only index of:
 *
 *   - the named docker volume of every per-card checkout, on whichever node ran
 *     it (`ws_<id>_<checkoutKey>_data`, labelled `redbtn.workspace`). The hourly
 *     reaper only ever looks at last-used age, so an orphan survived a full TTL
 *     on every node that had ever held one.
 *   - a parked keep-warm runner, which is a container holding that node's memory
 *     for a workspace nobody can check out any more.
 *   - the restic snapshots in MinIO. Nothing expires those: they are forever.
 *
 * So the delete fans out. The engine still never touches a docker socket — it
 * enqueues one `destroy` job per node onto the same per-node queues the snapshot
 * path already uses, and the per-node redrun worker does the removal. Exactly
 * one of those jobs also purges the restic repository, because the repository is
 * shared object storage and purging it N times is N-1 wasted prunes.
 *
 * The document is the map of where to look: the node pin, the parked runner, the
 * node each active checkout bound to, and every node that has reported a warm
 * volume for it (`stats.warmVolumes[]`, written by the workers' storage
 * sampler). When the document names no node at all — a workspace that never ran,
 * or one whose records predate the sampler — every workspace queue with a live
 * consumer is asked instead, so the fan-out is a superset of "wherever it could
 * be" rather than a guess.
 *
 * Fan-out is best effort by design. A node that is down when the job is enqueued
 * picks it up when it returns; a node that never gets one converges anyway,
 * because the reaper now removes any workspace-labelled volume whose document no
 * longer exists. What is NOT best effort is the busy check: a workspace with a
 * live checkout is not deleted at all, because the volume its run is writing to
 * would be pulled out from under it.
 */
import type { Db } from 'mongodb';
import {
  WORKSPACE_QUEUE,
  workspaceNodeQueue,
  bullLifecycleQueue,
  type LifecycleQueue,
} from './WorkspaceLifecycle.js';
import { WorkspaceError, type IWorkspace } from './types.js';

/** The collection `WorkspaceRepository` owns; destroy writes to it directly. */
export const AGENT_WORKSPACES_COLLECTION = 'agentWorkspaces';

/** Reported for the global-queue fallback, which is not one named node. */
export const ANY_WORKSPACE_NODE = '*';

/**
 * A workspace with a live checkout cannot be deleted: the run is writing to the
 * volume the destroy would remove. The caller turns this into a 409 and names
 * the checkouts, so a user can see what to wait for rather than "try again".
 */
export class WorkspaceBusyError extends WorkspaceError {
  readonly code = 'WORKSPACE_BUSY';
  constructor(
    readonly workspaceId: string,
    readonly checkouts: string[],
  ) {
    super(
      `Workspace "${workspaceId}" has ${checkouts.length} active checkout(s) and cannot be deleted: ${checkouts.join(', ')}`,
    );
    this.name = 'WorkspaceBusyError';
  }
}

export interface DestroyWorkspaceOptions {
  /** Who asked, recorded on the document for the moment it is in `deleting`. */
  requestedBy?: string;
  /** Extra nodes to fan out to, merged with the ones the document names. */
  nodeIds?: string[];
}

export interface DestroyWorkspaceResult {
  /** False only when there was no document to delete — deleting twice is success. */
  deleted: boolean;
  /** The nodes a destroy job was enqueued for, in fan-out order. */
  jobsEnqueued: string[];
}

export interface DestroyWorkspaceDeps {
  queue?: LifecycleQueue;
  now?: () => number;
}

/** One destroy target: the node it names, and the queue that reaches it. */
interface DestroyTarget {
  nodeId: string;
  queueName: string;
}

/**
 * The checkouts that still hold this workspace.
 *
 * An EXPIRED lease holds nothing — the same rule `checkoutWorkspace`'s CAS
 * applies, and without it one dead run would make a workspace undeletable
 * forever. A checkout that is still spawning is counted: it is pushed onto the
 * document before the spawn job is enqueued, and its lease is live.
 */
export function liveCheckoutIds(workspace: Pick<IWorkspace, 'activeCheckouts'>, nowMs: number): string[] {
  return (workspace.activeCheckouts ?? [])
    .filter((checkout) => {
      const lease = checkout?.leaseExpiresAt ? new Date(checkout.leaseExpiresAt).getTime() : 0;
      return Number.isFinite(lease) && lease > nowMs;
    })
    .map((checkout) => checkout.checkoutId)
    .filter(Boolean);
}

/** The per-node storage sampler's entries, which the engine only ever reads. */
interface WarmVolumeEntry {
  nodeId?: string;
}

/**
 * Every node the document says could be holding state for this workspace, in
 * the order they are worth asking: the pin first (it is where the volume was
 * last seen), then the parked runner's node, then the nodes bound to active
 * checkouts, then every node that has reported a warm volume.
 */
export function nodeIdsFromWorkspace(workspace: IWorkspace, extra: string[] = []): string[] {
  const warm = (workspace.stats as { warmVolumes?: WarmVolumeEntry[] } | undefined)?.warmVolumes ?? [];
  const candidates = [
    workspace.nodeId,
    workspace.parkedCheckout?.nodeId,
    ...(workspace.activeCheckouts ?? []).map((checkout) => checkout?.nodeId),
    ...(Array.isArray(warm) ? warm.map((entry) => entry?.nodeId) : []),
    ...extra,
  ];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const nodeId = typeof candidate === 'string' ? candidate.trim() : '';
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    out.push(nodeId);
  }
  return out;
}

/**
 * Where the destroy jobs go.
 *
 * The document's own nodes are never probed: a node that is merely down still
 * holds the volume, and a job waiting on its queue is exactly how it gets
 * cleaned up when the node comes back. Probing only decides the fallback, where
 * there is nothing to be faithful to and a queue with no consumer would swallow
 * the job forever.
 */
async function resolveDestroyTargets(
  queue: LifecycleQueue,
  workspace: IWorkspace,
  extra: string[],
): Promise<DestroyTarget[]> {
  const named = nodeIdsFromWorkspace(workspace, extra);
  if (named.length > 0) {
    return named.map((nodeId) => ({ nodeId, queueName: workspaceNodeQueue(nodeId) }));
  }

  // Nothing recorded. Ask every workspace queue that currently has a consumer,
  // which is the closest the engine gets to enumerating the fleet without a node
  // registry of its own.
  const discovered = queue.listNodeQueues ? await queue.listNodeQueues().catch(() => []) : [];
  const live: DestroyTarget[] = [];
  for (const queueName of discovered) {
    const nodeId = queueName.slice(`${WORKSPACE_QUEUE}--`.length);
    if (!nodeId) continue;
    const hasWorkers = queue.hasWorkers ? await queue.hasWorkers(queueName).catch(() => false) : true;
    if (hasWorkers) live.push({ nodeId, queueName });
  }
  if (live.length > 0) return live;

  // Not even that. The global queue still reaches ONE node, which is enough to
  // purge the snapshots — the part no reaper anywhere will ever do for us.
  return [{ nodeId: ANY_WORKSPACE_NODE, queueName: WORKSPACE_QUEUE }];
}

/**
 * Delete a workspace and everything it left on the fleet.
 *
 * Throws `WorkspaceBusyError` when a checkout is live. Returns
 * `{ deleted: false }` for a workspace that is already gone, so a retried
 * delete is a success rather than a 500.
 */
export async function destroyWorkspace(
  db: Db,
  workspaceId: string,
  options: DestroyWorkspaceOptions = {},
  deps: DestroyWorkspaceDeps = {},
): Promise<DestroyWorkspaceResult> {
  const queue = deps.queue ?? bullLifecycleQueue;
  const now = deps.now ?? (() => Date.now());
  const collection = db.collection<IWorkspace>(AGENT_WORKSPACES_COLLECTION);

  const workspace = (await collection.findOne({ workspaceId } as never)) as IWorkspace | null;
  if (!workspace) return { deleted: false, jobsEnqueued: [] };

  const busy = liveCheckoutIds(workspace, now());
  if (busy.length > 0) throw new WorkspaceBusyError(workspaceId, busy);

  // Marked BEFORE anything else, so a concurrent reader sees a workspace on its
  // way out rather than one that looks healthy while its volumes are removed.
  await collection.updateOne({ workspaceId } as never, {
    $set: {
      status: 'deleting',
      updatedAt: new Date(now()),
      ...(options.requestedBy ? { deletionRequestedBy: options.requestedBy } : {}),
    },
  } as never);

  const targets = await resolveDestroyTargets(queue, workspace, options.nodeIds ?? []);
  const jobsEnqueued: string[] = [];
  let snapshotsAssigned = false;

  for (const target of targets) {
    // Exactly one job purges the restic repository: it is shared object storage,
    // so the second prune would find nothing and the tenth would still pay for
    // the walk. It rides with the first job that is actually accepted, not the
    // first one attempted.
    const purgeSnapshots = !snapshotsAssigned;
    try {
      await enqueueDestroy(queue, target.queueName, {
        action: 'destroy',
        workspaceId,
        // The workspace's own user, which is the CALLER for anything a
        // delegated run created (`workspace_for_repo` → `resolveRunUserId`).
        // There is no run state here — a destroy is an API delete, not a step —
        // so there is no delegation to mark: the document is the only identity.
        userId: workspace.userId,
        purgeSnapshots,
      });
      jobsEnqueued.push(target.nodeId);
      if (purgeSnapshots) snapshotsAssigned = true;
    } catch (err) {
      // A queue that cannot be reached does not stop the delete: the reaper on
      // that node removes the orphaned volumes once its document is gone.
      console.warn(
        `[destroyWorkspace] ${workspaceId}: could not enqueue destroy on ${target.queueName}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await collection.deleteOne({ workspaceId } as never);

  console.log(
    `[destroyWorkspace] ${workspaceId} deleted${options.requestedBy ? ` by ${options.requestedBy}` : ''}; ` +
      `destroy enqueued on ${jobsEnqueued.length ? jobsEnqueued.join(', ') : 'no node'}` +
      `${snapshotsAssigned ? '' : ' (snapshots NOT purged)'}`,
  );

  return { deleted: true, jobsEnqueued };
}

/**
 * Enqueue without waiting. `runJob` blocks until the job completes, which is
 * right for a spawn and wrong here: a delete must not hold an HTTP request open
 * while every node in the fleet walks its docker state. A queue injected by an
 * older caller that only implements `runJob` still works, one node at a time.
 */
async function enqueueDestroy(
  queue: LifecycleQueue,
  queueName: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (queue.enqueue) {
    await queue.enqueue(queueName, 'destroy', data);
    return;
  }
  await queue.runJob(queueName, 'destroy', data, DESTROY_TIMEOUT_MS);
}

const DESTROY_TIMEOUT_MS = 5 * 60 * 1000;
