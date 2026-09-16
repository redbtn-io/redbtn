/**
 * Run-as-caller delegation for the managed-workspace tools.
 *
 * The platform already delegates: an automation with
 * `executionIdentity:'caller'` + `callerInvokable` is triggered by somebody who
 * is not its owner, the hub puts that VERIFIED caller on the run as
 * `connectionIdentityUserId`, and `buildInitialState` mirrors it onto state as
 * `callerUserId` (top level and `data.callerUserId`).
 * RUN-AS-CALLER-DELEGATION-SPEC.md's rule is that connections, environments and
 * secretRefs resolve as the CALLER while LLM access, tier gating and metering
 * stay on the OWNER. `ssh_shell` / `ssh_tail` / `ssh_kill` already follow it.
 *
 * The workspace tools did not. `resolveRunUserId` read only the owner chain, so
 * a delegated board dispatch found or created the OWNER's workspace, asked the
 * hub for the OWNER's GitHub App installation, and shipped every lifecycle job
 * with the owner's id — the caller's agent ran with the owner's repositories and
 * credentials, the exact inversion the spec exists to prevent. Card
 * 6aa9cc389cd36ab33ad10d76.
 *
 * Everything here is hermetic: the repository is an in-memory Map, the queue is
 * a recorder, and the hub is a stubbed fetch. No Mongo, no Redis, no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import forRepo from '../../src/lib/tools/native/workspace-for-repo';
import ship from '../../src/lib/tools/native/workspace-ship';
import merge from '../../src/lib/tools/native/workspace-merge';
import {
  resolveRunUserId,
  resolveRunOwnerUserId,
  resolveDelegatedFromUserId,
  resolveRunAccountTier,
  resolveJobInstallation,
} from '../../src/lib/tools/native/workspace-common';
import {
  buildReleaseJobData,
  WORKSPACE_QUEUE,
  workspaceNodeQueue,
  type LifecycleQueue,
} from '../../src/lib/workspaces/WorkspaceLifecycle';

const OWNER = 'owner-user';
const CALLER = 'caller-user';

const parse = (r: any) => JSON.parse(r.content[0].text);
const ctx = (state: any) =>
  ({ state, publisher: null, runId: 'run-1', nodeId: 'n', toolId: 't', abortSignal: null }) as any;

/** A run the hub delegated: owner on `userId`, verified caller on `callerUserId`. */
const delegated = (extra: Record<string, unknown> = {}) => ({
  userId: OWNER,
  callerUserId: CALLER,
  data: { userId: OWNER, callerUserId: CALLER, accountTier: 3, ...extra },
});

/** The same run undelegated — only the owner is on it. */
const plain = (extra: Record<string, unknown> = {}) => ({
  userId: OWNER,
  data: { userId: OWNER, accountTier: 3, ...extra },
});

/** Enough of a Db for WorkspaceRepository.findByName / createWorkspace / getWorkspace. */
function fakeDb() {
  const docs: any[] = [];
  const db = {
    collection() {
      return {
        async findOne(filter: any) {
          return (
            docs.find((d) => Object.entries(filter).every(([k, v]) => (d as any)[k] === v)) ?? null
          );
        },
        async insertOne(doc: any) {
          docs.push(doc);
          return { insertedId: doc.workspaceId };
        },
        async updateOne() {
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
    },
  };
  return { db, docs };
}

function fakeQueue() {
  const calls: Array<{ queueName: string; jobName: string; data: any; timeoutMs: number }> = [];
  const queue: LifecycleQueue = {
    async runJob(queueName, jobName, data, timeoutMs) {
      calls.push({ queueName, jobName, data, timeoutMs });
      if (jobName === 'push')
        return { ok: true, prUrl: 'https://github.com/redbtn-io/webapp/pull/9', prNumber: 9 };
      if (jobName === 'merge') return { ok: true, merged: true, mergedSha: 'c'.repeat(40) };
      return { ok: false };
    },
  };
  return { queue, calls };
}

describe('resolveRunUserId — the identity a workspace tool acts as', () => {
  it('prefers a top-level callerUserId over the owner', () => {
    expect(resolveRunUserId(ctx(delegated()))).toBe(CALLER);
  });

  it('prefers data.callerUserId when only the mirror is set', () => {
    expect(resolveRunUserId(ctx({ userId: OWNER, data: { userId: OWNER, callerUserId: CALLER } }))).toBe(
      CALLER
    );
  });

  it('falls back to the owner chain on an undelegated run', () => {
    expect(resolveRunUserId(ctx(plain()))).toBe(OWNER);
    expect(resolveRunUserId(ctx({ data: { options: { userId: OWNER } } }))).toBe(OWNER);
    expect(resolveRunUserId(ctx({ data: {} }))).toBeNull();
  });

  it('ignores a non-string or empty callerUserId rather than acting as nobody', () => {
    expect(resolveRunUserId(ctx({ userId: OWNER, callerUserId: '' }))).toBe(OWNER);
    expect(resolveRunUserId(ctx({ userId: OWNER, callerUserId: { id: CALLER } }))).toBe(OWNER);
  });
});

describe('the owner-keyed resolvers stay on the owner', () => {
  it('resolveRunOwnerUserId never returns the caller', () => {
    expect(resolveRunOwnerUserId(ctx(delegated()))).toBe(OWNER);
    expect(resolveRunOwnerUserId(ctx(plain()))).toBe(OWNER);
  });

  it('resolveRunAccountTier is the OWNER tier — tier gating and metering do not delegate', () => {
    expect(resolveRunAccountTier(ctx(delegated()))).toBe(3);
  });

  it('resolveDelegatedFromUserId names the owner only when the two differ', () => {
    expect(resolveDelegatedFromUserId(ctx(delegated()))).toBe(OWNER);
    expect(resolveDelegatedFromUserId(ctx(plain()))).toBeNull();
    expect(
      resolveDelegatedFromUserId(ctx({ userId: OWNER, callerUserId: OWNER, data: { userId: OWNER } }))
    ).toBeNull();
  });
});

describe('workspace_for_repo on a delegated run', () => {
  it('creates the workspace under the CALLER, with the OWNER account tier', async () => {
    const { db, docs } = fakeDb();
    const out = parse(
      await forRepo.handler(
        { repo: 'redbtn-io/webapp', branch: 'beta' },
        ctx({ ...delegated(), workspaceDb: db })
      )
    );
    expect(out.created).toBe(true);
    expect(docs).toHaveLength(1);
    expect(docs[0].userId).toBe(CALLER);
    expect(docs[0].userId).not.toBe(OWNER);
    // Tier 3's warm window, not Free's: the owner's plan still pays for storage.
    expect(docs[0].config.warmTtlSeconds).toBeGreaterThan(0);
  });

  it('finds the caller\'s existing workspace and never the owner\'s same-named one', async () => {
    const { db, docs } = fakeDb();
    const name = 'github.com/redbtn-io/webapp@beta';
    // The owner already has a workspace at the deterministic name. Before this
    // change, the delegated run bound straight to it.
    docs.push({ workspaceId: 'ws_owner', userId: OWNER, name, config: {} });
    const out = parse(
      await forRepo.handler({ repo: 'redbtn-io/webapp', branch: 'beta' }, ctx({ ...delegated(), workspaceDb: db }))
    );
    expect(out.created).toBe(true);
    expect(out.workspaceId).not.toBe('ws_owner');
    expect(docs.find((d) => d.workspaceId === out.workspaceId).userId).toBe(CALLER);
  });
});

describe('resolveJobInstallation asks the hub about the CALLER', () => {
  const asked: string[] = [];
  beforeEach(() => {
    asked.length = 0;
    process.env.INTERNAL_SERVICE_KEY = 'test-internal-service-key';
    process.env.WEBAPP_URL = 'http://hub.test';
    // A hub where only the OWNER has installed the App.
    vi.stubGlobal('fetch', async (url: string) => {
      const userId = new URL(String(url)).searchParams.get('userId') ?? '';
      asked.push(userId);
      return {
        ok: true,
        json: async () =>
          userId === OWNER ? { ok: true, installationId: 4242 } : { ok: false, code: 'not_installed' },
      } as any;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.WEBAPP_URL;
  });

  it('refuses with NO_GITHUB_APP for a caller with no installation, even though the owner has one', async () => {
    const resolved = await resolveJobInstallation(CALLER, 'redbtn-io/webapp');
    expect(asked).toEqual([CALLER]);
    expect(resolved.githubInstallationId).toBeNull();
    expect(resolved.error).toBeDefined();
    expect(parse(resolved.error)).toMatchObject({ code: 'NO_GITHUB_APP' });
    // And the owner's installation is never quietly substituted.
    expect(JSON.stringify(resolved)).not.toContain('4242');
  });

  it('returns the installation when the identity it is asked about has one', async () => {
    const resolved = await resolveJobInstallation(OWNER, 'redbtn-io/webapp');
    expect(resolved.error).toBeUndefined();
    expect(resolved.githubInstallationId).toBe(4242);
  });
});

describe('the lifecycle jobs a delegated run enqueues', () => {
  beforeEach(() => {
    // No hub: resolveGithubInstallation fails open with a null id, which is the
    // path that leaves the worker on its own resolution.
    delete process.env.INTERNAL_SERVICE_KEY;
  });

  it('workspace_merge carries the CALLER as ownerUserId and the OWNER as delegatedFromUserId', async () => {
    const { queue, calls } = fakeQueue();
    const out = parse(
      await merge.handler(
        { prUrl: 'https://github.com/redbtn-io/webapp/pull/9', timeoutMs: 5000 },
        ctx({ ...delegated(), workspaceQueue: queue })
      )
    );
    expect(out.merged).toBe(true);
    expect(calls[0].queueName).toBe(WORKSPACE_QUEUE);
    expect(calls[0].data).toMatchObject({
      action: 'merge',
      ownerUserId: CALLER,
      delegatedFromUserId: OWNER,
    });
  });

  it('workspace_merge on an undelegated run is unchanged: the owner, and no marker', async () => {
    const { queue, calls } = fakeQueue();
    await merge.handler(
      { prUrl: 'https://github.com/redbtn-io/webapp/pull/9' },
      ctx({ ...plain(), workspaceQueue: queue })
    );
    expect(calls[0].data.ownerUserId).toBe(OWNER);
    expect(calls[0].data.delegatedFromUserId).toBeUndefined();
  });

  it('workspace_ship pushes as the workspace owner (the caller) and marks the delegation', async () => {
    const { db, docs } = fakeDb();
    docs.push({
      workspaceId: 'ws_caller',
      userId: CALLER,
      name: 'github.com/redbtn-io/webapp@beta',
      config: { gitRepoUrl: 'https://github.com/redbtn-io/webapp.git', gitBranch: 'beta' },
    });
    const { queue, calls } = fakeQueue();
    const state = {
      ...delegated({
        ws: {
          workspaceId: 'ws_caller',
          checkoutId: 'chk_1',
          environmentId: 'env_1',
          nodeId: '10.100.0.8',
          mode: 'branch',
          checkoutKey: 'card-42',
        },
      }),
      workspaceDb: db,
      workspaceQueue: queue,
    };
    const out = parse(
      await ship.handler({ branch: 'red/fix', title: 'fix: it', environmentId: 'env_1' }, ctx(state))
    );
    expect(out.prUrl).toBe('https://github.com/redbtn-io/webapp/pull/9');
    expect(calls[0].queueName).toBe(workspaceNodeQueue('10.100.0.8'));
    expect(calls[0].data).toMatchObject({
      action: 'push',
      ownerUserId: CALLER,
      delegatedFromUserId: OWNER,
    });
    // Still never a credential on the wire.
    expect(JSON.stringify(calls[0].data)).not.toMatch(/ghs_|token/i);
  });

  it('buildReleaseJobData carries the marker when given one and omits the key otherwise', () => {
    const base = { workspaceId: 'ws_caller', checkoutId: 'chk_1', mode: 'branch' as const, checkoutKey: 'trunk', skipSnapshot: false };
    expect(buildReleaseJobData({ ...base, delegatedFromUserId: OWNER })).toMatchObject({
      action: 'snapshot',
      delegatedFromUserId: OWNER,
    });
    expect(buildReleaseJobData(base)).not.toHaveProperty('delegatedFromUserId');
  });
});
