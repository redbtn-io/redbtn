/**
 * The spawn job a delegated run enqueues.
 *
 * The producer half of run-as-caller (RUN-AS-CALLER-DELEGATION-SPEC.md, card
 * 6aa9cc389cd36ab33ad10d76). `acquireWorkspace` never sees the run's state: it
 * keys every identity decision off the WORKSPACE DOCUMENT, so the fix that
 * matters is upstream — `workspace_for_repo` now creates the workspace under
 * the caller, and the spawn's `ownerUserId` and the GitHub App installation
 * follow for free. What this pins is that nothing on the spawn path
 * reintroduces the run owner, and that the audit marker rides along.
 *
 * The repository and the hub are faked the way `workspace-spawn-teardown.test.ts`
 * fakes them: no Mongo, no Redis, no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { acquireWorkspace, type LifecycleQueue } from '../../src/lib/workspaces/WorkspaceLifecycle.js';
import type { Db } from 'mongodb';

const NODE = '10.100.0.7';
const WS = 'ws_delegated';
const OWNER = 'owner-user';
const CALLER = 'caller-user';

type Enqueued = { queueName: string; jobName: string; data: Record<string, unknown> };

const repo = vi.hoisted(() => ({
  checkoutWorkspace: vi.fn(),
  bindCheckoutRuntime: vi.fn(async () => {}),
  releaseWorkspace: vi.fn(async () => {}),
  setWorkspaceNode: vi.fn(async () => {}),
  clearWorkspaceNode: vi.fn(async () => {}),
  clearParkedCheckout: vi.fn(async () => {}),
  setParkedCheckout: vi.fn(async () => {}),
  renewWorkspaceLease: vi.fn(async () => {}),
}));

vi.mock('../../src/lib/workspaces/WorkspaceRepository.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    WorkspaceRepository: class {
      checkoutWorkspace = repo.checkoutWorkspace;
      bindCheckoutRuntime = repo.bindCheckoutRuntime;
      releaseWorkspace = repo.releaseWorkspace;
      setWorkspaceNode = repo.setWorkspaceNode;
      clearWorkspaceNode = repo.clearWorkspaceNode;
      clearParkedCheckout = repo.clearParkedCheckout;
      setParkedCheckout = repo.setParkedCheckout;
      renewWorkspaceLease = repo.renewWorkspaceLease;
    },
  };
});

/** The hub, recording which identity the producer asked it about. */
const hub = vi.hoisted(() => ({ asked: [] as (string | null | undefined)[] }));
vi.mock('../../src/lib/workspaces/github-installations.js', () => ({
  resolveGithubInstallation: vi.fn(async (userId: string) => {
    hub.asked.push(userId);
    return { installationId: userId === CALLER ? 777 : 111 };
  }),
}));

function fakeQueue() {
  const jobs: Enqueued[] = [];
  const queue: LifecycleQueue = {
    async runJob(queueName, jobName, data) {
      jobs.push({ queueName, jobName, data });
      if (jobName === 'spawn') {
        return {
          ok: true,
          nodeId: NODE,
          containerName: 'ws_delegated_chk1',
          volumeName: 'ws_delegated_data',
          installId: 'ws_delegated_chk1',
        };
      }
      return { ok: true };
    },
    async hasWorkers() {
      return true;
    },
  };
  return { queue, jobs };
}

const environments = { findByInstallId: async () => ({ environmentId: 'env_gateway' }) };

describe('acquireWorkspace on a delegated run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hub.asked = [];
    // The workspace belongs to the CALLER: `workspace_for_repo` created it
    // under `resolveRunUserId`, which now prefers state.callerUserId.
    repo.checkoutWorkspace.mockImplementation(async () => ({
      workspace: {
        workspaceId: WS,
        userId: CALLER,
        version: 1,
        config: { gitRepoUrl: 'https://github.com/redbtn-io/webapp.git', gitBranch: 'beta' },
      },
      checkout: {
        checkoutId: 'chk1',
        runId: 'R1',
        installId: 'ws_delegated_chk1',
        mode: 'branch',
        checkoutKey: 'card-42',
        environmentId: 'env_minted',
        branch: 'red/card-42',
      },
    }));
  });

  it('spawns as the CALLER, asks the hub about the CALLER, and marks the owner for audit only', async () => {
    const { queue, jobs } = fakeQueue();
    const session = await acquireWorkspace(
      {} as Db,
      { workspaceId: WS, runId: 'R1', workerId: 'w1', delegatedFromUserId: OWNER },
      { queue, environments } as never
    );
    const spawn = jobs.find((j) => j.jobName === 'spawn')!;
    expect(spawn.data.ownerUserId).toBe(CALLER);
    expect(spawn.data.delegatedFromUserId).toBe(OWNER);
    // The installation is the CALLER's — the owner's 111 never reaches the job.
    expect(hub.asked).toEqual([CALLER]);
    expect(spawn.data.githubInstallationId).toBe(777);

    // …and the release job that closes the checkout carries the same marker.
    await session.release({ skipSnapshot: true });
    const snapshot = jobs.find((j) => j.jobName === 'snapshot')!;
    expect(snapshot.data.delegatedFromUserId).toBe(OWNER);
  });

  it('adds nothing at all to an undelegated run', async () => {
    const { queue, jobs } = fakeQueue();
    const session = await acquireWorkspace(
      {} as Db,
      { workspaceId: WS, runId: 'R1', workerId: 'w1' },
      { queue, environments } as never
    );
    const spawn = jobs.find((j) => j.jobName === 'spawn')!;
    expect(spawn.data.ownerUserId).toBe(CALLER);
    expect(spawn.data).not.toHaveProperty('delegatedFromUserId');
    await session.release({ skipSnapshot: true });
    expect(jobs.find((j) => j.jobName === 'snapshot')!.data).not.toHaveProperty('delegatedFromUserId');
  });
});
