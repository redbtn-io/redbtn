/**
 * The three managed-workspace tools: workspace_for_repo (find/create by
 * repo+branch), workspace_ship (push + PR through the owning node's worker),
 * workspace_merge (merge-when-green on the global queue), and their
 * capability mapping. Queue and DB are injected through state, so nothing
 * here touches Redis; the repository half runs only when a Mongo is reachable.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import forRepo from '../../src/lib/tools/native/workspace-for-repo';
import ship from '../../src/lib/tools/native/workspace-ship';
import merge from '../../src/lib/tools/native/workspace-merge';
import { normalizeGithubRepo } from '../../src/lib/tools/native/workspace-common';
import { WorkspaceRepository } from '../../src/lib/workspaces/WorkspaceRepository';
import { WORKSPACE_QUEUE, workspaceNodeQueue, type LifecycleQueue } from '../../src/lib/workspaces/WorkspaceLifecycle';
import { enforceToolCapability } from '../../src/lib/permissions/enforce';
import { CapabilityDeniedError, type CapabilityProfile } from '../../src/lib/permissions/types';
import { redactSensitive } from '../../src/lib/utils/redact-sensitive';

const URI = process.env.WORKSPACE_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = `workspace_ship_tools_test_${Date.now()}`;
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
  await client?.close().catch(() => {});
  client = null;
}
afterAll(async () => {
  if (db) await db.dropDatabase().catch(() => {});
  await client?.close().catch(() => {});
});

const parse = (r: any) => JSON.parse(r.content[0].text);
const ctx = (state: any) => ({ state, publisher: null, runId: 'run-1', nodeId: 'n', toolId: 't', abortSignal: null }) as any;

function fakeQueue() {
  const calls: Array<{ queueName: string; jobName: string; data: any; timeoutMs: number }> = [];
  const queue: LifecycleQueue = {
    async runJob(queueName, jobName, data, timeoutMs) {
      calls.push({ queueName, jobName, data, timeoutMs });
      if (jobName === 'push') return { ok: true, branch: data.branch, headSha: 'a'.repeat(40), prUrl: 'https://github.com/redbtn-io/webapp/pull/7', prNumber: 7, created: true };
      if (jobName === 'merge') return { ok: true, merged: true, mergedSha: 'b'.repeat(40), prUrl: data.prUrl, checks: 'success' };
      return { ok: false };
    },
  };
  return { queue, calls };
}

describe('normalizeGithubRepo', () => {
  it('accepts owner/name, https, and ssh forms and never userinfo', () => {
    for (const input of ['redbtn-io/webapp', 'https://github.com/redbtn-io/webapp', 'https://github.com/redbtn-io/webapp.git', 'git@github.com:redbtn-io/webapp.git']) {
      expect(normalizeGithubRepo(input)).toEqual({ owner: 'redbtn-io', repo: 'webapp', url: 'https://github.com/redbtn-io/webapp.git' });
    }
    expect(normalizeGithubRepo('https://x:tok@github.com/o/r.git')).toBeNull();
    expect(normalizeGithubRepo('../etc')).toBeNull();
    expect(normalizeGithubRepo('')).toBeNull();
  });
});

describe('workspace_for_repo', () => {
  it('rejects a bad repo and a run with no user', async () => {
    expect(parse(await forRepo.handler({ repo: 'nope' }, ctx({ data: { userId: 'u' } }))).code).toBe('VALIDATION');
    expect(parse(await forRepo.handler({ repo: 'a/b' }, ctx({ data: {} }))).code).toBe('NO_USER');
  });

  it.skipIf(!available)('creates once, then finds the same workspace by its deterministic name', async () => {
    await new WorkspaceRepository(db as any).ensureIndexes().catch(() => {});
    const state = { data: { userId: 'user-1' }, workspaceDb: db };
    const first = parse(await forRepo.handler({ repo: 'redbtn-io/webapp', branch: 'beta' }, ctx(state)));
    expect(first.created).toBe(true);
    expect(first.name).toBe('github.com/redbtn-io/webapp@beta');
    expect(first.gitRepoUrl).toBe('https://github.com/redbtn-io/webapp.git');
    const again = parse(await forRepo.handler({ repo: 'https://github.com/redbtn-io/webapp.git', branch: 'beta' }, ctx(state)));
    expect(again.created).toBe(false);
    expect(again.workspaceId).toBe(first.workspaceId);
    const other = parse(await forRepo.handler({ repo: 'redbtn-io/webapp', branch: 'main' }, ctx(state)));
    expect(other.workspaceId).not.toBe(first.workspaceId);
    const doc = await (db as Db).collection('agentWorkspaces').findOne({ workspaceId: first.workspaceId });
    expect(doc?.config?.gitBranch).toBe('beta');
  });
});

describe('workspace_ship', () => {
  it('refuses when the run holds no workspace checkout', async () => {
    expect(parse(await ship.handler({ branch: 'red/x', title: 't' }, ctx({ data: {} }))).code).toBe('NO_WORKSPACE');
  });

  it.skipIf(!available)('sends a push job to the OWNING NODE with the working copy address and never a token', async () => {
    const repo = new WorkspaceRepository(db as any);
    const ws = await repo.createWorkspace({ userId: 'user-1', name: 'ship-test', config: { gitRepoUrl: 'https://github.com/redbtn-io/webapp.git', gitBranch: 'beta' } });
    const { queue, calls } = fakeQueue();
    const state = {
      data: { userId: 'user-1', ws: { workspaceId: ws.workspaceId, checkoutId: 'chk_1', environmentId: 'env_1', nodeId: '10.100.0.8', mode: 'branch', checkoutKey: 'card-42' } },
      workspaceDb: db, workspaceQueue: queue,
    };
    const out = parse(await ship.handler({ branch: 'red/fix', title: 'fix: it', body: 'because', environmentId: 'env_1' }, ctx(state)));
    expect(out.prUrl).toBe('https://github.com/redbtn-io/webapp/pull/7');
    expect(calls).toHaveLength(1);
    expect(calls[0].queueName).toBe(workspaceNodeQueue('10.100.0.8'));
    expect(calls[0].jobName).toBe('push');
    expect(calls[0].data).toMatchObject({ action: 'push', workspaceId: ws.workspaceId, checkoutId: 'chk_1', mode: 'branch', checkoutKey: 'card-42', branch: 'red/fix', title: 'fix: it', body: 'because', base: 'beta', gitRepoUrl: 'https://github.com/redbtn-io/webapp.git', ownerUserId: 'user-1' });
    expect(JSON.stringify(calls[0].data)).not.toMatch(/ghs_|token/i);
  });
});

describe('workspace_merge', () => {
  it('validates the PR URL and runs the merge on the global queue with the run user', async () => {
    expect(parse(await merge.handler({ prUrl: 'https://example.com/x' }, ctx({ data: {} }))).code).toBe('VALIDATION');
    const { queue, calls } = fakeQueue();
    const out = parse(await merge.handler({ prUrl: 'https://github.com/redbtn-io/webapp/pull/7', timeoutMs: 5000 }, ctx({ data: { userId: 'user-1' }, workspaceQueue: queue })));
    expect(out.merged).toBe(true);
    expect(calls[0].queueName).toBe(WORKSPACE_QUEUE);
    expect(calls[0].data).toMatchObject({ action: 'merge', prUrl: 'https://github.com/redbtn-io/webapp/pull/7', ownerUserId: 'user-1', timeoutMs: 5000, mergeMethod: 'squash' });
    expect(calls[0].timeoutMs).toBe(65000);
  });
});

describe('capability mapping', () => {
  const wild: CapabilityProfile = { name: 'wild', capabilities: [{ resource: 'exec', actions: ['execute'], selector: '*' }] };
  const scoped: CapabilityProfile = { name: 'scoped', capabilities: [{ resource: 'exec', actions: ['execute'], selector: 'env_1' }] };
  it('workspace_ship is scoped to the pinned environment like run_command', () => {
    expect(() => enforceToolCapability(scoped, 'workspace_ship', { environmentId: 'env_1', branch: 'b', title: 't' })).not.toThrow();
    expect(() => enforceToolCapability(scoped, 'workspace_ship', { environmentId: 'env_2', branch: 'b', title: 't' })).toThrow(CapabilityDeniedError);
    expect(() => enforceToolCapability(null, 'workspace_ship', { environmentId: 'env_1', branch: 'b', title: 't' })).toThrow(CapabilityDeniedError);
  });
  it('workspace_for_repo and workspace_merge are unscoped: a wildcard exec grant is required', () => {
    for (const t of ['workspace_for_repo', 'workspace_merge']) {
      expect(() => enforceToolCapability(wild, t, { repo: 'a/b', prUrl: 'x' })).not.toThrow();
      expect(() => enforceToolCapability(scoped, t, { repo: 'a/b', prUrl: 'x' })).toThrow(CapabilityDeniedError);
    }
  });
});

describe('redaction covers GitHub App and fine-grained tokens', () => {
  it('masks ghs_/gho_/github_pat_ values', () => {
    const out = redactSensitive({ a: 'token ghs_abcDEF1234567890abcDEF1234567890abcd end', b: 'x gho_1234567890abcdefghij y', c: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz' });
    expect(out.a).not.toMatch(/ghs_/);
    expect(out.b).not.toMatch(/gho_/);
    expect(out.c).not.toMatch(/github_pat_/);
  });
});
