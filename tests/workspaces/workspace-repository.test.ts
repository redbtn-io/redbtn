import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkspaceRepository,
  WorkspaceNotFoundError,
  WorkspaceLockedError,
  WorkspaceLeaseLostError,
  WorkspaceVersionConflictError,
  IWorkspace,
  IWorkspaceCheckout,
} from '../../src/lib/workspaces/index.js';
import type { Db, Collection, Filter } from 'mongodb';

/**
 * In-memory Mock Collection simulating MongoDB atomic operators:
 * $set, $inc, $push, $pull, $ne, $size, $expr
 */
class MockWorkspaceCollection {
  private docs: Map<string, IWorkspace> = new Map();

  async createIndex(): Promise<string> {
    return 'index_created';
  }

  async insertOne(doc: IWorkspace): Promise<{ insertedId: string }> {
    const clone = JSON.parse(JSON.stringify(doc));
    // Restore Dates
    clone.createdAt = new Date(doc.createdAt);
    clone.updatedAt = new Date(doc.updatedAt);
    this.docs.set(doc.workspaceId, clone);
    return { insertedId: doc.workspaceId };
  }

  async findOne(filter: Filter<IWorkspace>): Promise<IWorkspace | null> {
    for (const doc of this.docs.values()) {
      if (this.matches(doc, filter)) {
        return JSON.parse(JSON.stringify(doc), (k, v) => (k.endsWith('At') ? new Date(v) : v));
      }
    }
    return null;
  }

  find(filter: Record<string, any>): { toArray: () => Promise<IWorkspace[]> } {
    const results: IWorkspace[] = [];
    for (const doc of this.docs.values()) {
      if (this.matches(doc, filter)) {
        results.push(JSON.parse(JSON.stringify(doc), (k, v) => (k.endsWith('At') ? new Date(v) : v)));
      }
    }
    return {
      toArray: async () => results,
    };
  }

  async findOneAndUpdate(
    filter: Filter<IWorkspace>,
    update: Record<string, any>,
    options?: { returnDocument?: string }
  ): Promise<IWorkspace | null> {
    for (const [id, doc] of this.docs.entries()) {
      if (this.matches(doc, filter)) {
        this.applyUpdate(doc, update);
        const returned = JSON.parse(JSON.stringify(doc), (k, v) => (k.endsWith('At') ? new Date(v) : v));
        return returned;
      }
    }
    return null;
  }

  async updateOne(filter: Filter<IWorkspace>, update: Record<string, any>): Promise<{ matchedCount: number; modifiedCount: number }> {
    for (const doc of this.docs.values()) {
      if (this.matches(doc, filter)) {
        this.applyUpdate(doc, update);
        return { matchedCount: 1, modifiedCount: 1 };
      }
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async deleteOne(filter: { workspaceId: string }): Promise<{ deletedCount: number }> {
    const deleted = this.docs.delete(filter.workspaceId);
    return { deletedCount: deleted ? 1 : 0 };
  }

  private matches(doc: IWorkspace, filter: Record<string, any>): boolean {
    for (const [key, value] of Object.entries(filter)) {
      if (key === '$expr') {
        // Evaluate $lt: [{ $size: '$activeCheckouts' }, '$maxConcurrentCheckouts']
        const lt = value['$lt'];
        if (lt) {
          const currentSize = doc.activeCheckouts.length;
          const limit = doc.maxConcurrentCheckouts;
          if (!(currentSize < limit)) return false;
        }
      } else if (key === 'workspaceId') {
        if (doc.workspaceId !== value) return false;
      } else if (key === 'version') {
        if (doc.version !== value) return false;
      } else if (key === 'activeCheckouts.checkoutKey') {
        if (value && typeof value === 'object' && '$ne' in value) {
          const hasKey = doc.activeCheckouts.some((c) => c.checkoutKey === value.$ne);
          if (hasKey) return false;
        }
      } else if (key === 'activeCheckouts.mode') {
        if (value && typeof value === 'object' && '$ne' in value) {
          const hasMode = doc.activeCheckouts.some((c) => c.mode === value.$ne);
          if (hasMode) return false;
        }
      } else if (key === 'activeCheckouts.checkoutId') {
        const hasCheckout = doc.activeCheckouts.some((c) => c.checkoutId === value);
        if (!hasCheckout) return false;
      } else if (key === 'activeCheckouts.runId') {
        const hasRun = doc.activeCheckouts.some((c) => c.runId === value);
        if (!hasRun) return false;
      } else if (key === 'activeCheckouts.leaseExpiresAt') {
        if (value && typeof value === 'object' && '$lt' in value) {
          const hasExpired = doc.activeCheckouts.some((c) => c.leaseExpiresAt < value.$lt);
          if (!hasExpired) return false;
        }
      }
    }
    return true;
  }

  private applyUpdate(doc: IWorkspace, update: Record<string, any>): void {
    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        if (k === 'activeCheckouts') {
          doc.activeCheckouts.push(JSON.parse(JSON.stringify(v), (key, val) => (key.endsWith('At') ? new Date(val) : val)));
        }
      }
    }
    if (update.$pull) {
      for (const [k, v] of Object.entries(update.$pull)) {
        if (k === 'activeCheckouts') {
          const pullCriteria = v as any;
          if (pullCriteria.checkoutId && pullCriteria.checkoutId.$in) {
            const set = new Set(pullCriteria.checkoutId.$in);
            doc.activeCheckouts = doc.activeCheckouts.filter((c) => !set.has(c.checkoutId));
          } else if (pullCriteria.checkoutId) {
            doc.activeCheckouts = doc.activeCheckouts.filter((c) => c.checkoutId !== pullCriteria.checkoutId);
          }
        }
      }
    }
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        if (k === 'version') {
          doc.version += v as number;
        } else if (k === 'stats.totalRunCount') {
          doc.stats.totalRunCount += v as number;
        } else if (k === 'stats.totalComputeSeconds') {
          doc.stats.totalComputeSeconds += v as number;
        }
      }
    }
    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set)) {
        if (k === 'updatedAt') {
          doc.updatedAt = new Date(v);
        } else if (k === 'activeCheckouts.$.leaseExpiresAt') {
          // Update matching checkout
          if (doc.activeCheckouts.length > 0) {
            doc.activeCheckouts[0].leaseExpiresAt = new Date(v);
          }
        } else if (k === 'currentSnapshotId') {
          doc.currentSnapshotId = v;
        } else if (k === 'stats.snapshotSizeBytes') {
          doc.stats.snapshotSizeBytes = v;
        } else if (k === 'stats.fileCount') {
          doc.stats.fileCount = v;
        } else if (k === 'stats.lastSnapshotAt') {
          doc.stats.lastSnapshotAt = new Date(v);
        }
      }
    }
  }
}

describe('WorkspaceRepository (PR 1 CAS & Concurrency Engine)', () => {
  let mockCollection: MockWorkspaceCollection;
  let mockDb: Db;
  let repo: WorkspaceRepository;

  beforeEach(() => {
    mockCollection = new MockWorkspaceCollection();
    mockDb = {
      collection: () => mockCollection as unknown as Collection<IWorkspace>,
    } as unknown as Db;
    repo = new WorkspaceRepository(mockDb);
  });

  it('creates a workspace with default baseline configuration and initial version', async () => {
    const ws = await repo.createWorkspace({
      userId: 'user_123',
      name: 'Become Project',
      config: {
        gitRepoUrl: 'https://github.com/redbtn-io/become.git',
      },
    });

    expect(ws.workspaceId).toMatch(/^ws_[A-Za-z0-9_-]{12}$/);
    expect(ws.name).toBe('Become Project');
    expect(ws.userId).toBe('user_123');
    expect(ws.version).toBe(1);
    expect(ws.config.defaultCwd).toBe('/workspace');
    expect(ws.config.gitBranch).toBe('main');
    expect(ws.activeCheckouts).toEqual([]);
    expect(ws.currentSnapshotId).toBeNull();
  });

  it('retrieves an existing workspace by workspaceId', async () => {
    const created = await repo.createWorkspace({
      userId: 'user_123',
      name: 'Test Project',
    });

    const retrieved = await repo.getWorkspace(created.workspaceId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.workspaceId).toBe(created.workspaceId);

    const nonExistent = await repo.getWorkspace('ws_nonexistent');
    expect(nonExistent).toBeNull();
  });

  describe('Exclusive Checkout (Trunk / Discord Bot)', () => {
    it('successfully checks out an exclusive lease on trunk', async () => {
      const ws = await repo.createWorkspace({
        userId: 'user_123',
        name: 'Trunk Repo',
      });

      const { workspace: updated, checkout } = await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_trunk_01',
        workerId: 'worker_delta_1',
        mode: 'exclusive',
        checkoutKey: 'trunk',
        branch: 'main',
      });

      expect(updated.version).toBe(2);
      expect(checkout.checkoutId).toMatch(/^chk_[A-Za-z0-9_-]{10}$/);
      expect(checkout.mode).toBe('exclusive');
      expect(checkout.checkoutKey).toBe('trunk');
      expect(checkout.branch).toBe('main');
      expect(checkout.environmentId).toMatch(/^env_[A-Za-z0-9_-]{12}$/);
      expect(checkout.installId).toBe(`ws_${ws.workspaceId}_${checkout.checkoutId}`);
      expect(checkout.volumeName).toBe(`ws_${ws.workspaceId}_${checkout.checkoutId}_data`);
      expect(updated.activeCheckouts).toHaveLength(1);
    });

    it('rejects a second exclusive checkout while one is active', async () => {
      const ws = await repo.createWorkspace({
        userId: 'user_123',
        name: 'Exclusive Repo',
      });

      await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_1',
        workerId: 'worker_1',
        mode: 'exclusive',
        checkoutKey: 'trunk',
      });

      // Second checkout in exclusive mode must be rejected
      await expect(
        repo.checkoutWorkspace({
          workspaceId: ws.workspaceId,
          runId: 'run_2',
          workerId: 'worker_2',
          mode: 'exclusive',
          checkoutKey: 'trunk_secondary',
        })
      ).rejects.toThrow(WorkspaceLockedError);
    });
  });

  describe('Branch Checkout (Redboard Multi-Card Concurrency)', () => {
    it('allows multiple branch checkouts to run concurrently on different cards', async () => {
      const ws = await repo.createWorkspace({
        userId: 'user_123',
        name: 'Become Board',
      });

      // Card 101 checks out
      const res1 = await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_card_101',
        workerId: 'worker_1',
        mode: 'branch',
        checkoutKey: 'card-101',
        branch: 'task/card-101',
      });

      // Card 102 checks out concurrently
      const res2 = await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_card_102',
        workerId: 'worker_2',
        mode: 'branch',
        checkoutKey: 'card-102',
        branch: 'task/card-102',
      });

      expect(res1.checkout.checkoutKey).toBe('card-101');
      expect(res2.checkout.checkoutKey).toBe('card-102');
      expect(res1.checkout.checkoutId).not.toBe(res2.checkout.checkoutId);
      expect(res1.checkout.volumeName).not.toBe(res2.checkout.volumeName);

      const latest = await repo.getWorkspace(ws.workspaceId);
      expect(latest?.activeCheckouts).toHaveLength(2);
      expect(latest?.version).toBe(3); // Initial 1 + 2 checkouts
    });

    it('rejects duplicate checkouts for the exact same card (key deduplication)', async () => {
      const ws = await repo.createWorkspace({
        userId: 'user_123',
        name: 'Become Board',
      });

      await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_card_101_attempt_1',
        workerId: 'worker_1',
        mode: 'branch',
        checkoutKey: 'card-101',
      });

      // Same card-101 cannot check out twice simultaneously
      await expect(
        repo.checkoutWorkspace({
          workspaceId: ws.workspaceId,
          runId: 'run_card_101_attempt_2',
          workerId: 'worker_2',
          mode: 'branch',
          checkoutKey: 'card-101',
        })
      ).rejects.toThrow(WorkspaceLockedError);
    });

    it('enforces maxConcurrentCheckouts ceiling', async () => {
      const ws = await repo.createWorkspace({
        userId: 'user_123',
        name: 'Capped Workspace',
        maxConcurrentCheckouts: 2,
      });

      await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_1',
        workerId: 'w_1',
        mode: 'branch',
        checkoutKey: 'task-1',
      });

      await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_2',
        workerId: 'w_2',
        mode: 'branch',
        checkoutKey: 'task-2',
      });

      // 3rd checkout must fail limit
      await expect(
        repo.checkoutWorkspace({
          workspaceId: ws.workspaceId,
          runId: 'run_3',
          workerId: 'w_3',
          mode: 'branch',
          checkoutKey: 'task-3',
        })
      ).rejects.toThrow(WorkspaceLockedError);
    });
  });

  describe('Heartbeat Lease Renewal', () => {
    it('renews lease expiration timestamp for an active checkout', async () => {
      const ws = await repo.createWorkspace({
        userId: 'user_123',
        name: 'Heartbeat Workspace',
      });

      const { checkout } = await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_long_01',
        workerId: 'worker_1',
      });

      const initialExpiry = checkout.leaseExpiresAt.getTime();

      // Extend lease by 30 minutes
      await repo.renewWorkspaceLease(ws.workspaceId, checkout.checkoutId, 'run_long_01', 30 * 60 * 1000);

      const latest = await repo.getWorkspace(ws.workspaceId);
      const active = latest?.activeCheckouts.find((c) => c.checkoutId === checkout.checkoutId);
      expect(active?.leaseExpiresAt.getTime()).toBeGreaterThan(initialExpiry);
    });

    it('fails to renew lease if checkout was already released or runId mismatch', async () => {
      const ws = await repo.createWorkspace({
        userId: 'user_123',
        name: 'Heartbeat Workspace',
      });

      const { checkout } = await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_valid',
        workerId: 'worker_1',
      });

      await expect(
        repo.renewWorkspaceLease(ws.workspaceId, checkout.checkoutId, 'run_wrong_runid')
      ).rejects.toThrow(WorkspaceLeaseLostError);
    });
  });

  describe('Checkin & Release Mechanics', () => {
    it('releases a branch checkout without touching parent snapshot state', async () => {
      const ws = await repo.createWorkspace({
        userId: 'user_123',
        name: 'Branch Release',
      });

      const { workspace: checkedOut, checkout } = await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_branch_01',
        workerId: 'worker_1',
        mode: 'branch',
        checkoutKey: 'card-200',
      });

      await repo.releaseWorkspace({
        workspaceId: ws.workspaceId,
        checkoutId: checkout.checkoutId,
        runId: 'run_branch_01',
        expectedVersion: checkedOut.version,
        commitTrunkSnapshot: false,
        snapshotMeta: {
          snapshotId: 'snap_branch_only',
          snapshotSizeBytes: 5000,
          fileCount: 20,
          computeSeconds: 45,
        },
      });

      const finalWs = await repo.getWorkspace(ws.workspaceId);
      expect(finalWs?.activeCheckouts).toHaveLength(0);
      expect(finalWs?.currentSnapshotId).toBeNull(); // Untouched
      expect(finalWs?.stats.totalRunCount).toBe(1);
      expect(finalWs?.stats.totalComputeSeconds).toBe(45);
      expect(finalWs?.version).toBe(3); // 1 (create) + 1 (checkout) + 1 (release)
    });

    it('releases an exclusive checkout and updates parent snapshot on trunk commit', async () => {
      const ws = await repo.createWorkspace({
        userId: 'user_123',
        name: 'Trunk Release',
      });

      const { workspace: checkedOut, checkout } = await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_trunk_01',
        workerId: 'worker_1',
        mode: 'exclusive',
      });

      await repo.releaseWorkspace({
        workspaceId: ws.workspaceId,
        checkoutId: checkout.checkoutId,
        runId: 'run_trunk_01',
        expectedVersion: checkedOut.version,
        commitTrunkSnapshot: true,
        snapshotMeta: {
          snapshotId: 'snap_trunk_hash_abc',
          snapshotSizeBytes: 1048576,
          fileCount: 142,
          computeSeconds: 120,
        },
      });

      const finalWs = await repo.getWorkspace(ws.workspaceId);
      expect(finalWs?.activeCheckouts).toHaveLength(0);
      expect(finalWs?.currentSnapshotId).toBe('snap_trunk_hash_abc');
      expect(finalWs?.stats.snapshotSizeBytes).toBe(1048576);
      expect(finalWs?.stats.fileCount).toBe(142);
      expect(finalWs?.stats.lastSnapshotAt).not.toBeNull();
      expect(finalWs?.stats.totalRunCount).toBe(1);
    });

    it('throws WorkspaceVersionConflictError on optimistic CAS version mismatch', async () => {
      const ws = await repo.createWorkspace({
        userId: 'user_123',
        name: 'CAS Conflict Workspace',
      });

      const { checkout } = await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_conflict',
        workerId: 'worker_1',
      });

      // Expected version is wrong (e.g. outdated cached version)
      await expect(
        repo.releaseWorkspace({
          workspaceId: ws.workspaceId,
          checkoutId: checkout.checkoutId,
          runId: 'run_conflict',
          expectedVersion: 999,
        })
      ).rejects.toThrow(WorkspaceVersionConflictError);
    });
  });

  describe('Stale Checkout Reaping', () => {
    it('reaps expired checkouts while preserving active ones', async () => {
      const ws = await repo.createWorkspace({
        userId: 'user_123',
        name: 'Reaper Workspace',
      });

      // Checkout with negative lease duration (already expired)
      await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_expired',
        workerId: 'w_1',
        mode: 'branch',
        checkoutKey: 'expired-card',
        leaseDurationMs: -1000,
      });

      // Checkout with active future lease
      await repo.checkoutWorkspace({
        workspaceId: ws.workspaceId,
        runId: 'run_active',
        workerId: 'w_2',
        mode: 'branch',
        checkoutKey: 'active-card',
        leaseDurationMs: 60000,
      });

      const { reapedCount } = await repo.reapStaleCheckouts(ws.workspaceId);
      expect(reapedCount).toBe(1);

      const remaining = await repo.getWorkspace(ws.workspaceId);
      expect(remaining?.activeCheckouts).toHaveLength(1);
      expect(remaining?.activeCheckouts[0].checkoutKey).toBe('active-card');
    });
  });
});
