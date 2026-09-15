/**
 * The container that outlives its acquire.
 *
 * `acquireWorkspace`'s catch released the checkout in Mongo and nothing else,
 * on the reasoning that "the worker destroys the container on any spawn-side
 * failure". That holds only for failures INSIDE the spawn job. Once spawn has
 * RESOLVED the container is up and the node considers it delivered, so a
 * registration timeout — or a `bindCheckoutRuntime` that throws, or anything
 * else before the session is handed back — left a runner on the node with no
 * run attached. Prod, 2026-09-15, run `run_1789454050804_ufya17`: checkout
 * ws_is8EX3zJRoEh/chk_zdj49o23Sc registered at 06:54:04 (after the hub outage
 * that had already timed the acquire out) and ran unowned until it was removed
 * by hand.
 *
 * The repository is faked here rather than run against Mongo: what is under
 * test is which JOBS the producer enqueues and in what order relative to the
 * Mongo release, and both halves of that are observable without a database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  acquireWorkspace,
  workspaceNodeQueue,
  WorkspaceSpawnError,
  type LifecycleQueue,
} from '../../src/lib/workspaces/WorkspaceLifecycle.js';
import type { Db } from 'mongodb';

const NODE = '10.100.0.7';
const WS = 'ws_teardown';

type Enqueued = { queueName: string; jobName: string; data: Record<string, unknown>; timeoutMs: number };

/** Every repository call `acquireWorkspace` / `WorkspaceSession` can make. */
const repo = vi.hoisted(() => ({
  mode: 'branch' as 'branch' | 'exclusive',
  checkoutWorkspace: vi.fn(),
  bindCheckoutRuntime: vi.fn(async () => {}),
  releaseWorkspace: vi.fn(async () => {}),
  setWorkspaceNode: vi.fn(async () => {}),
  clearWorkspaceNode: vi.fn(async () => {}),
  clearParkedCheckout: vi.fn(async () => {}),
  setParkedCheckout: vi.fn(async () => {}),
  renewWorkspaceLease: vi.fn(async () => {}),
  /** Call order across the fake, so "torn down BEFORE released" is assertable. */
  calls: [] as string[],
}));

vi.mock('../../src/lib/workspaces/WorkspaceRepository.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    WorkspaceRepository: class {
      checkoutWorkspace = repo.checkoutWorkspace;
      bindCheckoutRuntime = (...a: unknown[]) => {
        repo.calls.push('bindCheckoutRuntime');
        return (repo.bindCheckoutRuntime as (...x: unknown[]) => Promise<void>)(...a);
      };
      releaseWorkspace = (...a: unknown[]) => {
        repo.calls.push('releaseWorkspace');
        return (repo.releaseWorkspace as (...x: unknown[]) => Promise<void>)(...a);
      };
      setWorkspaceNode = repo.setWorkspaceNode;
      clearWorkspaceNode = repo.clearWorkspaceNode;
      clearParkedCheckout = repo.clearParkedCheckout;
      setParkedCheckout = repo.setParkedCheckout;
      renewWorkspaceLease = repo.renewWorkspaceLease;
    },
  };
});

// No GitHub App round-trip: the producer resolves an installation only when the
// workspace carries a git repo, and none of these do.
vi.mock('../../src/lib/workspaces/github-installations.js', () => ({
  resolveGithubInstallation: vi.fn(async () => ({ installationId: null })),
}));

function fakeQueue(results: Record<string, unknown> = {}, failures: Record<string, string> = {}) {
  const jobs: Enqueued[] = [];
  const queue: LifecycleQueue = {
    async runJob(queueName, jobName, data, timeoutMs) {
      jobs.push({ queueName, jobName, data, timeoutMs });
      repo.calls.push(`job:${jobName}`);
      if (failures[jobName]) throw new WorkspaceSpawnError(failures[jobName]);
      return results[jobName];
    },
    async hasWorkers() {
      return true;
    },
  };
  return { queue, jobs };
}

const SPAWN_OK = {
  ok: true,
  containerName: 'ws_teardown_chk1',
  volumeName: 'ws_teardown_data',
  installId: 'ws_teardown_chk1',
  nodeId: NODE,
};

/** Time that always blows past the registration deadline on the first look. */
const impatient = () => {
  let t = 0;
  return { now: () => (t += 60_000), sleep: async () => {} };
};

const acquire = (deps: Record<string, unknown>) =>
  acquireWorkspace({} as Db, { workspaceId: WS, runId: 'R1', workerId: 'w1' }, deps as never);

describe('acquireWorkspace — a container that came up but was never handed over', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.calls = [];
    repo.mode = 'branch';
    process.env.INTERNAL_SERVICE_KEY = 'test-internal-service-key';
    repo.checkoutWorkspace.mockImplementation(async () => ({
      workspace: { workspaceId: WS, userId: 'user-1', version: 3, config: {} },
      checkout: {
        checkoutId: 'chk1',
        runId: 'R1',
        installId: 'ws_teardown_chk1',
        mode: repo.mode,
        checkoutKey: repo.mode === 'branch' ? 'task-a' : 'trunk',
        environmentId: 'env_minted',
        branch: 'main',
      },
    }));
  });

  it('tears the container down on the owning node when the runner never registers (branch: volume goes)', async () => {
    const { queue, jobs } = fakeQueue({ spawn: SPAWN_OK });

    await expect(
      acquire({ queue, environments: { findByInstallId: async () => null }, ...impatient() })
    ).rejects.toThrow(/never registered an environment/);

    const teardown = jobs.filter((j) => j.jobName === 'snapshot');
    expect(teardown).toHaveLength(1);
    expect(teardown[0].queueName).toBe(workspaceNodeQueue(NODE));
    expect(teardown[0].data).toEqual({
      action: 'snapshot',
      workspaceId: WS,
      checkoutId: 'chk1',
      mode: 'branch',
      checkoutKey: 'task-a',
      skipSnapshot: true,
      removeVolume: true,
    });
    // Nothing may park a container this path is destroying.
    expect(teardown[0].data.park).toBeUndefined();
    // Bounded, and not left on a snapshot-sized wait.
    expect(teardown[0].timeoutMs).toBeGreaterThan(0);
    expect(teardown[0].timeoutMs).toBeLessThanOrEqual(5 * 60 * 1000);

    // The node gets its container back BEFORE the slot goes back in Mongo.
    expect(repo.calls).toEqual(['job:spawn', 'job:snapshot', 'releaseWorkspace']);
    expect(repo.releaseWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, checkoutId: 'chk1', runId: 'R1', outcome: 'error' })
    );
  });

  it('keeps a trunk checkout\'s volume — the warm working copy is not the orphan', async () => {
    repo.mode = 'exclusive';
    const { queue, jobs } = fakeQueue({ spawn: SPAWN_OK });

    await expect(
      acquire({ queue, environments: { findByInstallId: async () => null }, ...impatient() })
    ).rejects.toThrow(/never registered an environment/);

    const teardown = jobs.find((j) => j.jobName === 'snapshot')!;
    expect(teardown.data).toMatchObject({ mode: 'exclusive', removeVolume: false, skipSnapshot: true });
    expect(repo.releaseWorkspace).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  it('enqueues nothing when the SPAWN itself failed — the worker already destroyed it', async () => {
    const { queue, jobs } = fakeQueue({}, { spawn: 'isolation is NOT in force' });

    await expect(acquire({ queue })).rejects.toThrow(/isolation is NOT in force/);

    expect(jobs.filter((j) => j.jobName === 'snapshot')).toHaveLength(0);
    expect(repo.calls).toEqual(['job:spawn', 'releaseWorkspace']);
    expect(repo.releaseWorkspace).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  it('enqueues nothing when the spawn returned no node — there is nowhere to send it', async () => {
    const { queue, jobs } = fakeQueue({ spawn: { ok: false } });

    await expect(acquire({ queue })).rejects.toThrow(/returned no node/);

    expect(jobs.filter((j) => j.jobName === 'snapshot')).toHaveLength(0);
    expect(repo.releaseWorkspace).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  it('tears down when bindCheckoutRuntime throws — anything after the spawn counts', async () => {
    const { queue, jobs } = fakeQueue({ spawn: SPAWN_OK });
    repo.bindCheckoutRuntime.mockRejectedValueOnce(new Error('lease lost to another run'));

    await expect(
      acquire({ queue, environments: { findByInstallId: async () => ({ environmentId: 'env_gw' }) } })
    ).rejects.toThrow(/lease lost to another run/);

    expect(jobs.filter((j) => j.jobName === 'snapshot')).toHaveLength(1);
    expect(repo.calls).toEqual([
      'job:spawn',
      'bindCheckoutRuntime',
      'job:snapshot',
      'releaseWorkspace',
    ]);
  });

  it('leaves the HEALTHY release job exactly as it was — same shape, snapshot kept, park intact', async () => {
    // Both paths now compose this job through one builder; this is the half
    // that must not have moved while the teardown half was added.
    const { queue, jobs } = fakeQueue({ spawn: SPAWN_OK, snapshot: { ok: true, parked: true } });
    repo.checkoutWorkspace.mockImplementationOnce(async () => ({
      workspace: { workspaceId: WS, userId: 'user-1', version: 3, config: { hotIdleSeconds: 120 } },
      checkout: {
        checkoutId: 'chk1',
        runId: 'R1',
        installId: 'ws_teardown_chk1',
        mode: 'exclusive',
        checkoutKey: 'trunk',
        environmentId: 'env_minted',
        branch: 'main',
      },
    }));

    const session = await acquire({
      queue,
      environments: { findByInstallId: async () => ({ environmentId: 'env_gw' }) },
    });
    await session.release();

    expect(jobs.find((j) => j.jobName === 'snapshot')!.data).toEqual({
      action: 'snapshot',
      workspaceId: WS,
      checkoutId: 'chk1',
      mode: 'exclusive',
      checkoutKey: 'trunk',
      skipSnapshot: false,
      removeVolume: false,
      park: { idleSeconds: 120, environmentId: 'env_gw' },
    });
    expect(repo.releaseWorkspace).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'released' }));
  });

  it('releases the checkout even when the teardown job itself fails', async () => {
    const { queue, jobs } = fakeQueue({ spawn: SPAWN_OK }, { snapshot: 'node is unreachable' });

    // The original failure is what the caller sees, not the teardown's.
    await expect(
      acquire({ queue, environments: { findByInstallId: async () => null }, ...impatient() })
    ).rejects.toThrow(/never registered an environment/);

    expect(jobs.filter((j) => j.jobName === 'snapshot')).toHaveLength(1);
    expect(repo.releaseWorkspace).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });
});
