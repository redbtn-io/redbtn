import type { Db, Collection, Filter } from 'mongodb';
import { randomBytes } from 'node:crypto';
import {
  IWorkspace,
  IWorkspaceCheckout,
  ICheckoutOptions,
  IReleaseOptions,
  CreateWorkspaceInput,
  WorkspaceNotFoundError,
  WorkspaceLockedError,
  WorkspaceLeaseLostError,
  WorkspaceVersionConflictError,
} from './types.js';

const NANOID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function generateRandomString(length: number): string {
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += NANOID_ALPHABET[bytes[i] & 0x3f];
  }
  return result;
}

export function generateWorkspaceId(): string {
  return `ws_${generateRandomString(12)}`;
}

export function generateCheckoutId(): string {
  return `chk_${generateRandomString(10)}`;
}

/**
 * 30 minutes, renewed every 60 s by the holder. The old 15-minute default was
 * shorter than real runs (Red Coder allows 50 tool iterations), so a second run
 * could check the same workspace out while the first was still writing.
 */
export const DEFAULT_LEASE_DURATION_MS = 30 * 60 * 1000;

/**
 * How long a node pin is worth following, in seconds. Matches the node-side
 * volume reaper's default TTL: past it the idle volume has been deleted, so the
 * pin points at a node with nothing warm on it.
 */
export const DEFAULT_WARM_TTL_SECONDS = 24 * 60 * 60;

/** A workspace's warm window in seconds: its own config, or the 24 h default. */
export function warmTtlSeconds(config?: { warmTtlSeconds?: number } | null): number {
  const configured = config?.warmTtlSeconds;
  return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_WARM_TTL_SECONDS;
}

export function generateEnvironmentId(): string {
  return `env_${generateRandomString(12)}`;
}

export class WorkspaceRepository {
  private collectionName = 'agentWorkspaces';

  constructor(private db: Db) {}

  private get collection(): Collection<IWorkspace> {
    return this.db.collection<IWorkspace>(this.collectionName);
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ workspaceId: 1 }, { unique: true });
    await this.collection.createIndex({ userId: 1, name: 1 }, { unique: true });
    await this.collection.createIndex({ 'activeCheckouts.checkoutId': 1 });
    await this.collection.createIndex({ 'activeCheckouts.checkoutKey': 1 });
    await this.collection.createIndex({ 'activeCheckouts.environmentId': 1 });
    await this.collection.createIndex({ 'activeCheckouts.leaseExpiresAt': 1 });
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<IWorkspace> {
    const now = new Date();
    const workspaceId = input.workspaceId || generateWorkspaceId();
    // The node's redrun worker derives the real repository from its own
    // WORKSPACE_S3_* env; this field is informational. It carries no IP literal:
    // the endpoint is node configuration, not code (48a P2-6).
    const resticRepo =
      input.resticRepository ||
      `s3:${(process.env.WORKSPACE_S3_ENDPOINT || 's3-endpoint-unset').replace(/\/$/, '')}/${process.env.WORKSPACE_S3_BUCKET || 'workspaces'}/${workspaceId}`;

    const doc: IWorkspace = {
      workspaceId,
      userId: input.userId,
      name: input.name,
      description: input.description,
      resticRepository: resticRepo,
      currentSnapshotId: null,
      config: {
        dockerImage: input.config?.dockerImage || 'workspace-runner:latest',
        cpuLimit: input.config?.cpuLimit || '2.0',
        memLimit: input.config?.memLimit || '4096m',
        defaultCwd: '/workspace',
        gitRepoUrl: input.config?.gitRepoUrl,
        gitBranch: input.config?.gitBranch || 'main',
        warmTtlSeconds: warmTtlSeconds(input.config),
      },
      stats: {
        snapshotSizeBytes: 0,
        lastSnapshotAt: null,
        fileCount: 0,
        totalRunCount: 0,
        totalComputeSeconds: 0,
      },
      version: 1,
      maxConcurrentCheckouts: input.maxConcurrentCheckouts ?? 8,
      activeCheckouts: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(doc as any);
    return doc;
  }

  /** Lookup by the (userId, name) unique key — how a repo's managed workspace is found. */
  async findByName(userId: string, name: string): Promise<IWorkspace | null> {
    return (await this.collection.findOne({ userId, name } as Filter<IWorkspace>)) as IWorkspace | null;
  }

  async getWorkspace(workspaceId: string): Promise<IWorkspace | null> {
    return await this.collection.findOne({ workspaceId } as Filter<IWorkspace>);
  }

  async checkoutWorkspace(
    options: ICheckoutOptions
  ): Promise<{ workspace: IWorkspace; checkout: IWorkspaceCheckout }> {
    const {
      workspaceId,
      runId,
      workerId,
      checkoutKey = 'trunk',
      mode = 'exclusive',
      branch = mode === 'branch' ? `task/${checkoutKey}` : 'main',
      leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
    } = options;

    const existing = await this.getWorkspace(workspaceId);
    if (!existing) {
      throw new WorkspaceNotFoundError(workspaceId);
    }

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
    const checkoutId = generateCheckoutId();
    const installId = `ws_${workspaceId}_${checkoutId}`;
    const volumeName = `ws_${workspaceId}_${checkoutId}_data`;
    const environmentId = generateEnvironmentId();

    const newCheckout: IWorkspaceCheckout = {
      checkoutId,
      checkoutKey,
      mode,
      branch,
      runId,
      workerId,
      environmentId,
      installId,
      volumeName,
      leaseExpiresAt,
      createdAt: now,
    };

    // Concurrency CAS filter:
    // 1. Workspace ID matches
    // 2. No active non-expired checkout has the SAME checkoutKey (idempotency)
    // 3. If requesting 'exclusive', no active non-expired checkout is 'exclusive'
    // 4. Total active checkouts is below maxConcurrentCheckouts
    // The comments used to claim "non-expired" filtering the filter did not
    // implement, so a single expired checkout blocked the workspace forever and
    // only a hand edit could free it (48a). These now genuinely ignore expired
    // checkouts: an expired lease holds nothing.
    const filter: Record<string, any> = {
      workspaceId,
      activeCheckouts: {
        $not: { $elemMatch: { checkoutKey, leaseExpiresAt: { $gt: now } } },
      },
      $expr: {
        $lt: [
          {
            $size: {
              $filter: {
                input: '$activeCheckouts',
                as: 'c',
                cond: { $gt: ['$$c.leaseExpiresAt', now] },
              },
            },
          },
          '$maxConcurrentCheckouts',
        ],
      },
    };

    if (mode === 'exclusive') {
      filter.$and = [
        {
          activeCheckouts: {
            $not: { $elemMatch: { mode: 'exclusive', leaseExpiresAt: { $gt: now } } },
          },
        },
      ];
    }

    const doc = await this.collection.findOneAndUpdate(
      filter as Filter<IWorkspace>,
      {
        $push: { activeCheckouts: newCheckout } as any,
        $inc: { version: 1 },
        $set: { updatedAt: now },
      },
      { returnDocument: 'after' }
    );

    if (!doc) {
      throw new WorkspaceLockedError(
        `Cannot checkout workspace "${workspaceId}" with key "${checkoutKey}" (mode: ${mode}): slot busy, key active, or concurrency limit reached`
      );
    }

    return { workspace: doc, checkout: newCheckout };
  }

  /**
   * Record what the spawn produced: the environmentId the GATEWAY assigned (not
   * the one minted at checkout — see WorkspaceLifecycle), and the node that
   * holds the container and volume, so snapshot/reap can be routed back to it.
   */
  async bindCheckoutRuntime(
    workspaceId: string,
    checkoutId: string,
    runId: string,
    runtime: { environmentId: string; nodeId: string; containerName?: string; volumeName?: string }
  ): Promise<void> {
    const now = new Date();
    const set: Record<string, any> = {
      'activeCheckouts.$[elem].environmentId': runtime.environmentId,
      'activeCheckouts.$[elem].nodeId': runtime.nodeId,
      updatedAt: now,
    };
    if (runtime.containerName) set['activeCheckouts.$[elem].containerName'] = runtime.containerName;
    if (runtime.volumeName) set['activeCheckouts.$[elem].volumeName'] = runtime.volumeName;

    const res = await this.collection.updateOne(
      { workspaceId, activeCheckouts: { $elemMatch: { checkoutId, runId } } } as Filter<IWorkspace>,
      { $set: set },
      { arrayFilters: [{ 'elem.checkoutId': checkoutId, 'elem.runId': runId }] }
    );

    if (res.matchedCount === 0) {
      throw new WorkspaceLeaseLostError(
        `Cannot bind runtime to checkout "${checkoutId}" on workspace "${workspaceId}": the checkout is gone`
      );
    }
  }

  /**
   * Record the node whose docker daemon holds this workspace's named volume,
   * and how long that is worth following. Callers holding the workspace pass
   * `pinnedUntil` (they already know its warm window); without one it is read
   * from the stored config, so the older two-argument call still means
   * "pinned for the configured warm window from now".
   */
  async setWorkspaceNode(workspaceId: string, nodeId: string, pinnedUntil?: Date): Promise<void> {
    const now = new Date();
    let until = pinnedUntil;
    if (!until) {
      const doc = await this.collection.findOne(
        { workspaceId } as Filter<IWorkspace>,
        { projection: { config: 1 }, maxTimeMS: 5000 }
      );
      until = new Date(now.getTime() + warmTtlSeconds(doc?.config) * 1000);
    }
    await this.collection.updateOne(
      { workspaceId } as Filter<IWorkspace>,
      { $set: { nodeId, nodePinnedUntil: until, updatedAt: now } as any }
    );
  }

  /**
   * Forget where the volume lived. The node reports `volumeRemoved` when it
   * deletes the working copy: nothing warm is left there, so the pin has to go
   * with it or every later run pays a cold restore on that one node — or waits
   * out the spawn timeout on a queue nobody consumes, if the node has left.
   */
  async clearWorkspaceNode(workspaceId: string): Promise<void> {
    await this.collection.updateOne({ workspaceId } as Filter<IWorkspace>, {
      $unset: { nodeId: '', nodePinnedUntil: '' },
      $set: { updatedAt: new Date() },
    } as any);
  }

  async renewWorkspaceLease(
    workspaceId: string,
    checkoutId: string,
    runId: string,
    extensionMs = 15 * 60 * 1000
  ): Promise<void> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + extensionMs);

    const res = await this.collection.updateOne(
      {
        workspaceId,
        activeCheckouts: {
          $elemMatch: { checkoutId, runId },
        },
      } as Filter<IWorkspace>,
      {
        $set: {
          'activeCheckouts.$[elem].leaseExpiresAt': leaseExpiresAt,
          updatedAt: now,
        },
      },
      {
        arrayFilters: [{ 'elem.checkoutId': checkoutId, 'elem.runId': runId }],
      }
    );

    if (res.matchedCount === 0) {
      throw new WorkspaceLeaseLostError(
        `Failed to renew lease for checkout "${checkoutId}" on workspace "${workspaceId}": lease lost or checkout completed`
      );
    }
  }

  async releaseWorkspace(options: IReleaseOptions): Promise<void> {
    const {
      workspaceId,
      checkoutId,
      runId,
      expectedVersion,
      commitTrunkSnapshot,
      snapshotMeta,
    } = options;
    const now = new Date();

    const update: Record<string, any> = {
      $pull: { activeCheckouts: { checkoutId, runId } },
      $inc: {
        version: 1,
        'stats.totalRunCount': 1,
        ...(snapshotMeta?.computeSeconds
          ? { 'stats.totalComputeSeconds': snapshotMeta.computeSeconds }
          : {}),
      },
      $set: { updatedAt: now },
    };

    if (commitTrunkSnapshot && snapshotMeta) {
      update.$set['currentSnapshotId'] = snapshotMeta.snapshotId;
      update.$set['stats.snapshotSizeBytes'] = snapshotMeta.snapshotSizeBytes;
      update.$set['stats.fileCount'] = snapshotMeta.fileCount;
      update.$set['stats.lastSnapshotAt'] = now;
    }

    // Guarded on the CHECKOUT, not on the document version. `version` is $inc'd
    // by every other checkout, by the reaper and by the UI's PATCH, so with
    // parallel branch checkouts a whole-document CAS was guaranteed to conflict
    // and the checkout then leaked forever, filling the workspace's slots
    // (48a P1-9). `expectedVersion` is accepted for callers that genuinely want
    // the stricter guard, but it is no longer required.
    const filter: Record<string, any> = {
      workspaceId,
      activeCheckouts: { $elemMatch: { checkoutId, runId } },
    };
    if (typeof expectedVersion === 'number' && options.enforceVersion) {
      filter.version = expectedVersion;
    }

    const res = await this.collection.updateOne(filter as Filter<IWorkspace>, update);

    if (res.matchedCount === 0) {
      throw new WorkspaceVersionConflictError(
        `Failed to release checkout "${checkoutId}" on workspace "${workspaceId}": no matching active checkout for this run`
      );
    }
  }

  async reapStaleCheckouts(
    workspaceId?: string
  ): Promise<{ reapedCount: number }> {
    const now = new Date();
    const query: Record<string, any> = {
      'activeCheckouts.leaseExpiresAt': { $lt: now },
    };
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    const workspacesWithExpired = await this.collection
      .find(query)
      .limit(200)
      .maxTimeMS(5000)
      .toArray();
    let reapedCount = 0;

    for (const ws of workspacesWithExpired) {
      const expiredCheckouts = ws.activeCheckouts.filter(
        (c) => c.leaseExpiresAt < now
      );
      if (expiredCheckouts.length === 0) continue;

      const expiredIds = expiredCheckouts.map((c) => c.checkoutId);
      const res = await this.collection.updateOne(
        { workspaceId: ws.workspaceId, version: ws.version },
        {
          $pull: {
            activeCheckouts: { checkoutId: { $in: expiredIds } },
          } as any,
          $inc: { version: 1 },
          $set: { updatedAt: now },
        }
      );

      if (res.modifiedCount > 0) {
        reapedCount += expiredIds.length;
      }
    }

    return { reapedCount };
  }

  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    const res = await this.collection.deleteOne({ workspaceId });
    return res.deletedCount > 0;
  }
}
