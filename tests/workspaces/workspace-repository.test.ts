/**
 * WorkspaceRepository against a REAL MongoDB.
 *
 * The previous version of this file reimplemented `$expr`, `$ne`, `$push`,
 * `$pull`, `$inc` and the positional `$` by hand — and got them wrong in exactly
 * the way production was wrong, so `renewWorkspaceLease`'s cross-element bug
 * passed for the wrong reason (48a P1-8), and when the mock was later "fixed" it
 * modelled `$elemMatch` semantics real Mongo does not give a bare `$` (50a 1c).
 * A CAS engine can only be tested against the engine that runs it.
 *
 * Skipped (not failed) when no Mongo is reachable, so CI without a database
 * still goes green; point WORKSPACE_TEST_MONGODB_URI at any throwaway server.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import {
  WorkspaceRepository,
  WorkspaceLockedError,
  WorkspaceLeaseLostError,
  WorkspaceVersionConflictError,
  DEFAULT_LEASE_DURATION_MS,
} from '../../src/lib/workspaces';

const URI = process.env.WORKSPACE_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = `workspace_repo_test_${Date.now()}`;

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

describe('WorkspaceRepository (real MongoDB CAS engine)', () => {
  let repo: WorkspaceRepository;

  beforeEach(async () => {
    if (!available) return;
    await db!.collection('agentWorkspaces').deleteMany({});
    repo = new WorkspaceRepository(db!);
  });

  // `accountTier: 0` because the storage tier now decides the concurrency cap
  // (see tiers.ts): without a tier every workspace here would be provisioned
  // Free, whose cap is below the parallel-checkout counts these CAS tests need.
  const mkWorkspace = (over: Partial<Parameters<WorkspaceRepository['createWorkspace']>[0]> = {}) =>
    repo.createWorkspace({ userId: 'user-1', accountTier: 0, name: `ws-${Math.random().toString(36).slice(2)}`, ...over } as any);

  it.skipIf(!available)('serialises exclusive checkouts: the second is refused, not queued', async () => {
    const ws = await mkWorkspace();
    const first = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'run-a', workerId: 'w1' });
    expect(first.checkout.checkoutId).toMatch(/^chk_/);

    await expect(
      repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'run-b', workerId: 'w2', checkoutKey: 'other' })
    ).rejects.toThrow(WorkspaceLockedError);

    const after = await repo.getWorkspace(ws.workspaceId);
    expect(after!.activeCheckouts).toHaveLength(1);
    expect(after!.activeCheckouts[0].runId).toBe('run-a');
  });

  it.skipIf(!available)('refuses a second checkout with the same key (idempotency), even in branch mode', async () => {
    const ws = await mkWorkspace();
    await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'run-a', workerId: 'w1', mode: 'branch', checkoutKey: 'card-1' });
    await expect(
      repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'run-b', workerId: 'w2', mode: 'branch', checkoutKey: 'card-1' })
    ).rejects.toThrow(WorkspaceLockedError);
  });

  it.skipIf(!available)('allows parallel branch checkouts up to maxConcurrentCheckouts', async () => {
    const ws = await mkWorkspace({ maxConcurrentCheckouts: 2 } as any);
    await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'r1', workerId: 'w', mode: 'branch', checkoutKey: 'c1' });
    await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'r2', workerId: 'w', mode: 'branch', checkoutKey: 'c2' });
    await expect(
      repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'r3', workerId: 'w', mode: 'branch', checkoutKey: 'c3' })
    ).rejects.toThrow(WorkspaceLockedError);
  });

  it.skipIf(!available)('an EXPIRED checkout no longer blocks the workspace forever', async () => {
    const ws = await mkWorkspace();
    await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'dead-run', workerId: 'w', leaseDurationMs: 1 });
    await new Promise((r) => setTimeout(r, 25));

    // Before the fix the CAS filter ignored expiry despite a comment claiming
    // otherwise: a worker that died mid-run wedged the workspace permanently.
    const second = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'new-run', workerId: 'w', checkoutKey: 'fresh' });
    expect(second.checkout.runId).toBe('new-run');
  });

  it.skipIf(!available)('renews EXACTLY the targeted checkout when runIds and checkoutIds cross elements', async () => {
    const ws = await mkWorkspace({ maxConcurrentCheckouts: 4 } as any);
    const a = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w', mode: 'branch', checkoutKey: 'A' });
    const b = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R2', workerId: 'w', mode: 'branch', checkoutKey: 'B' });

    const before = await repo.getWorkspace(ws.workspaceId);
    const aBefore = before!.activeCheckouts.find((c) => c.checkoutId === a.checkout.checkoutId)!.leaseExpiresAt;

    // (checkout B, run R1) satisfies each dotted predicate on a DIFFERENT
    // element. Two independent dotted predicates would match and the positional
    // `$` would then renew element 0 — extending A's lease on B's authority.
    await expect(
      repo.renewWorkspaceLease(ws.workspaceId, b.checkout.checkoutId, 'R1')
    ).rejects.toThrow(WorkspaceLeaseLostError);

    const after = await repo.getWorkspace(ws.workspaceId);
    expect(after!.activeCheckouts.find((c) => c.checkoutId === a.checkout.checkoutId)!.leaseExpiresAt.getTime())
      .toBe(aBefore.getTime());
  });

  it.skipIf(!available)('renews the right element when the pair does match', async () => {
    const ws = await mkWorkspace({ maxConcurrentCheckouts: 4 } as any);
    const a = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w', mode: 'branch', checkoutKey: 'A', leaseDurationMs: 60_000 });
    const b = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R2', workerId: 'w', mode: 'branch', checkoutKey: 'B', leaseDurationMs: 60_000 });

    const before = await repo.getWorkspace(ws.workspaceId);
    const aBefore = before!.activeCheckouts.find((c) => c.checkoutId === a.checkout.checkoutId)!.leaseExpiresAt.getTime();

    await repo.renewWorkspaceLease(ws.workspaceId, b.checkout.checkoutId, 'R2', 10 * 60 * 1000);

    const after = await repo.getWorkspace(ws.workspaceId);
    const bAfter = after!.activeCheckouts.find((c) => c.checkoutId === b.checkout.checkoutId)!.leaseExpiresAt.getTime();
    const aAfter = after!.activeCheckouts.find((c) => c.checkoutId === a.checkout.checkoutId)!.leaseExpiresAt.getTime();
    expect(bAfter).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
    expect(aAfter).toBe(aBefore);
  });

  it.skipIf(!available)('releases a checkout even after other checkouts bumped the document version', async () => {
    const ws = await mkWorkspace({ maxConcurrentCheckouts: 4 } as any);
    const mine = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w', mode: 'branch', checkoutKey: 'A' });
    // Two more checkouts land between my checkout and my release.
    await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R2', workerId: 'w', mode: 'branch', checkoutKey: 'B' });
    await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R3', workerId: 'w', mode: 'branch', checkoutKey: 'C' });

    // The old whole-document version CAS made this a guaranteed conflict, so the
    // checkout leaked and the workspace filled its slots (48a P1-9).
    await repo.releaseWorkspace({
      workspaceId: ws.workspaceId,
      checkoutId: mine.checkout.checkoutId,
      runId: 'R1',
      expectedVersion: mine.workspace.version,
    });

    const after = await repo.getWorkspace(ws.workspaceId);
    expect(after!.activeCheckouts.map((c) => c.checkoutId)).not.toContain(mine.checkout.checkoutId);
    expect(after!.activeCheckouts).toHaveLength(2);
    expect(after!.stats.totalRunCount).toBe(1);
  });

  it.skipIf(!available)('refuses to release a checkout that belongs to another run', async () => {
    const ws = await mkWorkspace();
    const mine = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w' });
    await expect(
      repo.releaseWorkspace({ workspaceId: ws.workspaceId, checkoutId: mine.checkout.checkoutId, runId: 'SOMEONE-ELSE' })
    ).rejects.toThrow(WorkspaceVersionConflictError);
  });

  it.skipIf(!available)('writes absolute snapshot stats and increments only the counters', async () => {
    const ws = await mkWorkspace();
    const c = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w' });
    await repo.releaseWorkspace({
      workspaceId: ws.workspaceId,
      checkoutId: c.checkout.checkoutId,
      runId: 'R1',
      commitTrunkSnapshot: true,
      snapshotMeta: { snapshotId: 'snap-1', snapshotSizeBytes: 4096, fileCount: 12, computeSeconds: 30 },
    });
    const after = await repo.getWorkspace(ws.workspaceId);
    expect(after!.currentSnapshotId).toBe('snap-1');
    expect(after!.stats.snapshotSizeBytes).toBe(4096);
    expect(after!.stats.fileCount).toBe(12);
    expect(after!.stats.totalComputeSeconds).toBe(30);
    expect((after as any).snapshotSizeBytes).toBeUndefined();
  });

  it.skipIf(!available)('binds the gateway-assigned environmentId and node to the right checkout', async () => {
    const ws = await mkWorkspace({ maxConcurrentCheckouts: 4 } as any);
    const a = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w', mode: 'branch', checkoutKey: 'A' });
    const b = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R2', workerId: 'w', mode: 'branch', checkoutKey: 'B' });

    await repo.bindCheckoutRuntime(ws.workspaceId, b.checkout.checkoutId, 'R2', {
      environmentId: 'env_fromGateway',
      nodeId: '10.100.0.5',
      containerName: 'ws_x_chk',
    });

    const after = await repo.getWorkspace(ws.workspaceId);
    const bDoc = after!.activeCheckouts.find((c) => c.checkoutId === b.checkout.checkoutId)!;
    const aDoc = after!.activeCheckouts.find((c) => c.checkoutId === a.checkout.checkoutId)!;
    expect(bDoc.environmentId).toBe('env_fromGateway');
    expect(bDoc.nodeId).toBe('10.100.0.5');
    expect(aDoc.environmentId).not.toBe('env_fromGateway');
    expect(aDoc.nodeId).toBeUndefined();

    await expect(
      repo.bindCheckoutRuntime(ws.workspaceId, b.checkout.checkoutId, 'WRONG-RUN', { environmentId: 'env_x', nodeId: 'n' })
    ).rejects.toThrow(WorkspaceLeaseLostError);
  });

  it.skipIf(!available)('reaps only expired checkouts', async () => {
    const ws = await mkWorkspace({ maxConcurrentCheckouts: 4 } as any);
    await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'dead', workerId: 'w', mode: 'branch', checkoutKey: 'dead', leaseDurationMs: 1 });
    const live = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'live', workerId: 'w', mode: 'branch', checkoutKey: 'live', leaseDurationMs: 600_000 });
    await new Promise((r) => setTimeout(r, 25));

    const { reapedCount } = await repo.reapStaleCheckouts(ws.workspaceId);
    expect(reapedCount).toBe(1);
    const after = await repo.getWorkspace(ws.workspaceId);
    expect(after!.activeCheckouts.map((c) => c.checkoutId)).toEqual([live.checkout.checkoutId]);
  });

  it.skipIf(!available)('defaults the lease to 30 minutes, longer than a real CLI step', async () => {
    const ws = await mkWorkspace();
    const c = await repo.checkoutWorkspace({ workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w' });
    const ms = c.checkout.leaseExpiresAt.getTime() - Date.now();
    expect(DEFAULT_LEASE_DURATION_MS).toBe(30 * 60 * 1000);
    expect(ms).toBeGreaterThan(29 * 60 * 1000);
  });
});
