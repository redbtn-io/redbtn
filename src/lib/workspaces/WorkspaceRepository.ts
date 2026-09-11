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

export function generateEnvironmentId(): string {
  return `env_${generateRandomString(12)}`;
}

export class WorkspaceRepository {
  private collectionName = 'workspaces';

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
    const resticRepo =
      input.resticRepository ||
      `s3:http://192.168.1.10:9000/workspaces/${workspaceId}`;

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
      leaseDurationMs = 15 * 60 * 1000,
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
    const filter: Record<string, any> = {
      workspaceId,
      'activeCheckouts.checkoutKey': { $ne: checkoutKey },
      $expr: {
        $lt: [{ $size: '$activeCheckouts' }, '$maxConcurrentCheckouts'],
      },
    };

    if (mode === 'exclusive') {
      filter['activeCheckouts.mode'] = { $ne: 'exclusive' };
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
        'activeCheckouts.checkoutId': checkoutId,
        'activeCheckouts.runId': runId,
      } as Filter<IWorkspace>,
      {
        $set: {
          'activeCheckouts.$.leaseExpiresAt': leaseExpiresAt,
          updatedAt: now,
        },
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

    const res = await this.collection.updateOne(
      {
        workspaceId,
        version: expectedVersion,
        'activeCheckouts.checkoutId': checkoutId,
      } as Filter<IWorkspace>,
      update
    );

    if (res.matchedCount === 0) {
      throw new WorkspaceVersionConflictError(
        `Failed to release checkout "${checkoutId}" on workspace "${workspaceId}": concurrent version conflict or invalid checkout`
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

    const workspacesWithExpired = await this.collection.find(query).toArray();
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
