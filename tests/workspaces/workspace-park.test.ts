/**
 * The hot tier: the container that survives its checkout.
 *
 * A warm volume still cost every run a container start plus the runner's
 * registration with the hub. With `config.hotIdleSeconds` the release asks the
 * node to PARK the runner instead of destroying it, the workspace remembers
 * where it is, and the next acquire on that node adopts it — inheriting the
 * install id its environment is registered under, so there is nothing to wait
 * for.
 *
 * Real MongoDB (see workspace-repository.test.ts for why), queue and gateway
 * injected, so nothing here needs Redis or a docker socket.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import {
  acquireWorkspace,
  WorkspaceRepository,
  MAX_HOT_IDLE_SECONDS,
  hotIdleSeconds,
  workspaceNodeQueue,
  type LifecycleQueue,
} from '../../src/lib/workspaces';

const URI = process.env.WORKSPACE_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = `workspace_park_test_${Date.now()}`;

let client: MongoClient | null = null;
let db: Db | null = null;
let available = false;
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

type Enqueued = { queueName: string; jobName: string; data: Record<string, unknown> };

function fakeQueue(results: Record<string, any> = {}) {
  const jobs: Enqueued[] = [];
  const queue: LifecycleQueue = {
    async runJob(queueName, jobName, data) {
      jobs.push({ queueName, jobName, data });
      return results[jobName];
    },
    async hasWorkers() {
      return true;
    },
  };
  return { queue, jobs };
}

/** Counts every trip to the gateway, so "skipped the wait" can be asserted. */
function fakeGateway(environmentId = 'env_gateway') {
  const lookups: string[] = [];
  return {
    lookups,
    gateway: {
      async findByInstallId(_userId: string, installId: string) {
        lookups.push(installId);
        return { environmentId };
      },
    },
  };
}

const NODE = '10.100.0.5';
const spawnOk = (over: Record<string, any> = {}) => ({
  ok: true,
  containerName: 'ws_abc_chk_new',
  volumeName: 'ws_abc_data',
  installId: 'ws_abc_chk_new',
  nodeId: NODE,
  ...over,
});

const seconds = (until: Date | null | undefined) =>
  until ? Math.round((new Date(until).getTime() - Date.now()) / 1000) : NaN;

describe('workspace hot tier (parked runners)', () => {
  let repo: WorkspaceRepository;
  const OLD_KEY = process.env.INTERNAL_SERVICE_KEY;

  beforeEach(async () => {
    if (!available) return;
    process.env.INTERNAL_SERVICE_KEY = 'test-internal-service-key';
    await db!.collection('agentWorkspaces').deleteMany({});
    repo = new WorkspaceRepository(db!);
  });

  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.INTERNAL_SERVICE_KEY;
    else process.env.INTERNAL_SERVICE_KEY = OLD_KEY;
  });

  const mk = (config?: { hotIdleSeconds?: number }) =>
    repo.createWorkspace({
      userId: 'user-1',
      name: `hot-${Math.random().toString(36).slice(2)}`,
      ...(config ? { config } : {}),
    });

  it('stores a hot window clamped to the hour ceiling, and nothing at all by default', async () => {
    expect(MAX_HOT_IDLE_SECONDS).toBe(3600);
    // A parked runner holds this node's memory for nobody, and it keeps the
    // registration token it was spawned with — an unbounded park buys a
    // container that cannot reconnect.
    expect(hotIdleSeconds({ hotIdleSeconds: 99999 })).toBe(MAX_HOT_IDLE_SECONDS);
    expect(hotIdleSeconds({ hotIdleSeconds: -5 })).toBe(0);
    expect(hotIdleSeconds(null)).toBe(0);

    if (!available) return;
    expect((await mk({ hotIdleSeconds: 300 })).config.hotIdleSeconds).toBe(300);
    expect((await mk({ hotIdleSeconds: 99999 })).config.hotIdleSeconds).toBe(MAX_HOT_IDLE_SECONDS);
    expect((await mk()).config.hotIdleSeconds).toBe(0);
  });

  it.skipIf(!available)('asks the node to park on release, and remembers the runner it kept', async () => {
    const ws = await mk({ hotIdleSeconds: 120 });
    const { queue, jobs } = fakeQueue({
      spawn: spawnOk(),
      snapshot: { ok: true, snapshotId: 'snap-1', snapshotSizeBytes: 1, fileCount: 1, durationSeconds: 2, volumeRemoved: false, parked: true, parkedUntil: Date.now() + 120_000 },
    });
    const { gateway } = fakeGateway('env_live');

    const session = await acquireWorkspace(db!, { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' }, { queue, environments: gateway });
    await session.release();

    const snapshot = jobs.find((j) => j.jobName === 'snapshot')!;
    expect(snapshot.data.park).toEqual({ idleSeconds: 120, environmentId: 'env_live' });

    const doc = await repo.getWorkspace(ws.workspaceId);
    expect(doc!.parkedCheckout).toMatchObject({
      checkoutId: session.acquired.checkout.checkoutId,
      installId: session.acquired.checkout.installId,
      environmentId: 'env_live',
      containerName: 'ws_abc_chk_new',
      nodeId: NODE,
    });
    expect(seconds(doc!.parkedCheckout!.parkedUntil)).toBeGreaterThan(110);
    // The pin follows the warm data as before: the volume is still there too.
    expect(doc!.nodeId).toBe(NODE);
  });

  it.skipIf(!available)('sends no park when the tier is off, and forgets a runner the node did not keep', async () => {
    const ws = await mk();
    await repo.setParkedCheckout(ws.workspaceId, {
      checkoutId: 'chk_stale',
      installId: 'ws_abc_chk_stale',
      environmentId: 'env_stale',
      containerName: 'ws_abc_chk_stale',
      nodeId: NODE,
      parkedUntil: new Date(Date.now() + 60_000),
    });
    const { queue, jobs } = fakeQueue({
      spawn: spawnOk(),
      snapshot: { ok: true, snapshotId: 'snap-2', volumeRemoved: false, parked: false },
    });
    const { gateway } = fakeGateway();

    const session = await acquireWorkspace(db!, { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' }, { queue, environments: gateway });
    await session.release();

    expect(jobs.find((j) => j.jobName === 'snapshot')!.data.park).toBeUndefined();
    expect((await repo.getWorkspace(ws.workspaceId))!.parkedCheckout).toBeUndefined();
  });

  it.skipIf(!available)('adopts the parked runner: its install id, its environment, and no wait for a registration', async () => {
    const ws = await mk({ hotIdleSeconds: 300 });
    await repo.setWorkspaceNode(ws.workspaceId, NODE, new Date(Date.now() + 3600_000));
    await repo.setParkedCheckout(ws.workspaceId, {
      checkoutId: 'chk_old',
      installId: 'ws_abc_chk_old',
      environmentId: 'env_parked',
      containerName: 'ws_abc_chk_old',
      nodeId: NODE,
      parkedUntil: new Date(Date.now() + 240_000),
    });
    const { queue, jobs } = fakeQueue({ spawn: spawnOk({ adopted: true, installId: 'ws_abc_chk_old', containerName: 'ws_abc_chk_new' }) });
    const { gateway, lookups } = fakeGateway();

    const session = await acquireWorkspace(db!, { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' }, { queue, environments: gateway });

    expect(jobs[0].queueName).toBe(workspaceNodeQueue(NODE));
    expect(jobs[0].data.preferParked).toBe(true);
    // The runner never disconnected, so the gateway has nothing new to tell us —
    // and the ~15 s this tier exists to save is exactly that wait.
    expect(lookups).toEqual([]);
    expect(session.environmentId).toBe('env_parked');
    expect(session.acquired.checkout.installId).toBe('ws_abc_chk_old');

    const doc = await repo.getWorkspace(ws.workspaceId);
    // The checkout has to carry the ADOPTED install id: the environment on the
    // hub is registered under it, and the minted one names a container that was
    // never started.
    expect(doc!.activeCheckouts[0].installId).toBe('ws_abc_chk_old');
    expect(doc!.activeCheckouts[0].environmentId).toBe('env_parked');
    // The park is spent — this container belongs to the new checkout now.
    expect(doc!.parkedCheckout).toBeUndefined();
  });

  it.skipIf(!available)('ignores a park that has expired: no hint, no shortcut, and the record goes', async () => {
    const ws = await mk({ hotIdleSeconds: 300 });
    await repo.setWorkspaceNode(ws.workspaceId, NODE, new Date(Date.now() + 3600_000));
    await repo.setParkedCheckout(ws.workspaceId, {
      checkoutId: 'chk_old',
      installId: 'ws_abc_chk_old',
      environmentId: 'env_parked',
      containerName: 'ws_abc_chk_old',
      nodeId: NODE,
      parkedUntil: new Date(Date.now() - 60_000),
    });
    const { queue, jobs } = fakeQueue({ spawn: spawnOk() });
    const { gateway, lookups } = fakeGateway('env_fresh');

    const session = await acquireWorkspace(db!, { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' }, { queue, environments: gateway });

    expect(jobs[0].data.preferParked).toBeUndefined();
    // The node reaps a container the moment its window passes, so the gateway is
    // the only thing that can say what registered — under the id THIS checkout
    // minted, because a cold spawn registers as itself.
    expect(lookups).toEqual([session.acquired.checkout.installId]);
    expect(session.acquired.checkout.installId).toContain(ws.workspaceId);
    expect(session.environmentId).toBe('env_fresh');
    expect((await repo.getWorkspace(ws.workspaceId))!.parkedCheckout).toBeUndefined();
  });

  it.skipIf(!available)('will not chase a runner parked on a node the spawn is not going to', async () => {
    // The pin sends this spawn to OTHER; a container warming on NODE is no use
    // to it, and claiming otherwise would skip a registration wait it needs.
    const ws = await mk({ hotIdleSeconds: 300 });
    const OTHER = '10.100.0.7';
    await repo.setWorkspaceNode(ws.workspaceId, OTHER, new Date(Date.now() + 3600_000));
    await repo.setParkedCheckout(ws.workspaceId, {
      checkoutId: 'chk_old',
      installId: 'ws_abc_chk_old',
      environmentId: 'env_parked',
      containerName: 'ws_abc_chk_old',
      nodeId: NODE,
      parkedUntil: new Date(Date.now() + 240_000),
    });
    const { queue, jobs } = fakeQueue({ spawn: spawnOk({ nodeId: OTHER }) });
    const { gateway, lookups } = fakeGateway('env_fresh');

    const session = await acquireWorkspace(db!, { workspaceId: ws.workspaceId, runId: 'R1', workerId: 'w1' }, { queue, environments: gateway });

    expect(jobs[0].queueName).toBe(workspaceNodeQueue(OTHER));
    expect(jobs[0].data.preferParked).toBeUndefined();
    expect(lookups).toEqual([session.acquired.checkout.installId]);
    expect(session.environmentId).toBe('env_fresh');
  });
});
