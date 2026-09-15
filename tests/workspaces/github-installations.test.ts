/**
 * Per-installation GitHub tokens — the engine half.
 *
 * The platform owns the App (id + private key); a user owns only an
 * INSTALLATION of it, and the hub is the only place that knows which one. So
 * the engine asks the hub and puts the answer on the lifecycle job as
 * `githubInstallationId`, and the two facts worth pinning are:
 *
 *   1. A real "you have no installation for this repo" (`not_installed` /
 *      `not_authorized`) STOPS the tool, with the one sentence a person can
 *      act on.
 *   2. Anything else — a cold hub, no App configured, a network error — is
 *      `githubInstallationId: null` and the job still runs, so the worker's
 *      existing owner/allowlist path keeps the platform's own workspaces
 *      working through the transition.
 *
 * The hub is stubbed (`fetch`); nothing here touches Mongo, Redis or GitHub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveGithubInstallation,
  githubInstallMessage,
  repoSlug,
  GITHUB_APP_INSTALL_URL,
} from '../../src/lib/workspaces/github-installations';
import ship from '../../src/lib/tools/native/workspace-ship';
import merge from '../../src/lib/tools/native/workspace-merge';
import { WORKSPACE_QUEUE, workspaceNodeQueue, type LifecycleQueue } from '../../src/lib/workspaces/WorkspaceLifecycle';

const OLD_WEBAPP = process.env.WEBAPP_URL;
const OLD_KEY = process.env.INTERNAL_SERVICE_KEY;

/** One hub answer, plus the requests it saw. */
function fakeHub(answer: unknown, status = 200) {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(answer), { status });
    }),
  );
  return calls;
}

function fakeQueue() {
  const calls: Array<{ queueName: string; jobName: string; data: any }> = [];
  const queue: LifecycleQueue = {
    async runJob(queueName, jobName, data) {
      calls.push({ queueName, jobName, data });
      if (jobName === 'push') return { ok: true, prUrl: 'https://github.com/redbtn-io/webapp/pull/7', prNumber: 7 };
      return { ok: true, merged: true, checks: 'success' };
    },
  };
  return { queue, calls };
}

/** A workspace document, served without Mongo. */
const workspaceDb = (doc: Record<string, unknown>) =>
  ({ collection: () => ({ findOne: async () => doc }) }) as any;

const WS_DOC = {
  workspaceId: 'ws_abc',
  userId: 'user-1',
  config: { gitRepoUrl: 'https://github.com/redbtn-io/webapp.git', gitBranch: 'beta' },
};

const shipCtx = (queue: LifecycleQueue) =>
  ({
    state: {
      data: {
        userId: 'user-1',
        ws: { workspaceId: 'ws_abc', checkoutId: 'chk_1', nodeId: '10.100.0.8', mode: 'branch', checkoutKey: 'card-42' },
      },
      workspaceDb: workspaceDb(WS_DOC),
      workspaceQueue: queue,
    },
  }) as any;

const mergeCtx = (queue: LifecycleQueue) =>
  ({ state: { data: { userId: 'user-1' }, workspaceQueue: queue } }) as any;

const parse = (r: any) => JSON.parse(r.content[0].text);

beforeEach(() => {
  process.env.WEBAPP_URL = 'http://hub.test';
  process.env.INTERNAL_SERVICE_KEY = 'svc-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (OLD_WEBAPP === undefined) delete process.env.WEBAPP_URL;
  else process.env.WEBAPP_URL = OLD_WEBAPP;
  if (OLD_KEY === undefined) delete process.env.INTERNAL_SERVICE_KEY;
  else process.env.INTERNAL_SERVICE_KEY = OLD_KEY;
});

describe('resolveGithubInstallation', () => {
  it('asks the hub for (user, repo) with the service key and returns the installation', async () => {
    const calls = fakeHub({ ok: true, installationId: 146426922, account: { login: 'redbtn-io', type: 'Organization' } });
    const got = await resolveGithubInstallation('user-1', 'https://github.com/redbtn-io/webapp.git');
    expect(got).toEqual({ installationId: 146426922, account: { login: 'redbtn-io', type: 'Organization' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'http://hub.test/api/v1/internal/github/app/resolve?userId=user-1&repo=redbtn-io%2Fwebapp',
    );
    expect(calls[0].init.headers['x-service-key']).toBe('svc-key');
    expect(calls[0].init.method).toBe('GET');
  });

  it('passes the hub\'s refusal codes through with a null id', async () => {
    for (const code of ['not_installed', 'not_authorized', 'github_app_not_configured'] as const) {
      fakeHub({ ok: false, code });
      expect(await resolveGithubInstallation('user-1', 'redbtn-io/webapp')).toEqual({ installationId: null, code });
    }
  });

  it('reports resolver_unavailable for a non-2xx, a network error, and a broken ok:true', async () => {
    fakeHub({ error: 'boom' }, 503);
    expect(await resolveGithubInstallation('user-1', 'redbtn-io/webapp')).toEqual({
      installationId: null,
      code: 'resolver_unavailable',
    });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await resolveGithubInstallation('user-1', 'redbtn-io/webapp')).toEqual({
      installationId: null,
      code: 'resolver_unavailable',
    });

    fakeHub({ ok: true }); // no installationId — an answer that answers nothing
    expect(await resolveGithubInstallation('user-1', 'redbtn-io/webapp')).toEqual({
      installationId: null,
      code: 'resolver_unavailable',
    });
  });

  it('never POSTs without a service key, a user, or a parsable repo', async () => {
    const calls = fakeHub({ ok: true, installationId: 1 });
    delete process.env.INTERNAL_SERVICE_KEY;
    expect((await resolveGithubInstallation('user-1', 'redbtn-io/webapp')).code).toBe('resolver_unavailable');
    process.env.INTERNAL_SERVICE_KEY = 'svc-key';
    expect((await resolveGithubInstallation('', 'redbtn-io/webapp')).code).toBe('resolver_unavailable');
    expect((await resolveGithubInstallation('user-1', 'not a repo')).code).toBe('resolver_unavailable');
    expect(calls).toHaveLength(0);
  });

  it('normalises every repo form the platform records, and the install message names the fix', () => {
    for (const input of [
      'redbtn-io/webapp',
      'https://github.com/redbtn-io/webapp',
      'https://github.com/redbtn-io/webapp.git',
      'git@github.com:redbtn-io/webapp.git',
    ]) {
      expect(repoSlug(input)).toBe('redbtn-io/webapp');
    }
    expect(repoSlug('../etc')).toBeNull();
    expect(githubInstallMessage('redbtn-io/webapp', 'not_installed')).toContain(
      `Install the Red by redbtn App for redbtn-io/webapp at ${GITHUB_APP_INSTALL_URL}, then retry`,
    );
    expect(githubInstallMessage('redbtn-io/webapp', 'not_authorized')).toContain(
      `Install the Red by redbtn App for redbtn-io/webapp at ${GITHUB_APP_INSTALL_URL}, then retry`,
    );
  });
});

describe('workspace_ship', () => {
  it('carries the resolved installation onto the push job', async () => {
    fakeHub({ ok: true, installationId: 146426922 });
    const { queue, calls } = fakeQueue();
    const out = parse(await ship.handler({ branch: 'red/fix', title: 'fix: it' }, shipCtx(queue)));
    expect(out.prNumber).toBe(7);
    expect(calls[0].queueName).toBe(workspaceNodeQueue('10.100.0.8'));
    expect(calls[0].data).toMatchObject({ action: 'push', ownerUserId: 'user-1', githubInstallationId: 146426922 });
  });

  it('refuses with the install link when the owner has no installation for the repo', async () => {
    fakeHub({ ok: false, code: 'not_installed' });
    const { queue, calls } = fakeQueue();
    const out = parse(await ship.handler({ branch: 'red/fix', title: 'fix: it' }, shipCtx(queue)));
    expect(out.code).toBe('NO_GITHUB_APP');
    expect(out.error).toContain(
      `Install the Red by redbtn App for redbtn-io/webapp at ${GITHUB_APP_INSTALL_URL}, then retry`,
    );
    expect(calls).toHaveLength(0); // nothing was enqueued
  });

  it('still ships with a null id when the hub itself is unavailable (transition)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('hub is cold'); }));
    const { queue, calls } = fakeQueue();
    const out = parse(await ship.handler({ branch: 'red/fix', title: 'fix: it' }, shipCtx(queue)));
    expect(out.prNumber).toBe(7);
    expect(calls[0].data.githubInstallationId).toBeNull();
    expect(calls[0].data.ownerUserId).toBe('user-1'); // the worker's own path still applies
  });
});

describe('workspace_merge', () => {
  it('resolves the installation from the pull request\'s repo and puts it on the merge job', async () => {
    const calls = fakeHub({ ok: true, installationId: 42 });
    const { queue, calls: jobs } = fakeQueue();
    const out = parse(
      await merge.handler({ prUrl: 'https://github.com/redbtn-io/webapp/pull/7' }, mergeCtx(queue)),
    );
    expect(out.merged).toBe(true);
    expect(calls[0].url).toContain('repo=redbtn-io%2Fwebapp');
    expect(jobs[0].queueName).toBe(WORKSPACE_QUEUE);
    expect(jobs[0].data).toMatchObject({ action: 'merge', ownerUserId: 'user-1', githubInstallationId: 42 });
  });

  it('refuses when the installation does not cover the repository', async () => {
    fakeHub({ ok: false, code: 'not_authorized' });
    const { queue, calls: jobs } = fakeQueue();
    const out = parse(
      await merge.handler({ prUrl: 'https://github.com/redbtn-io/webapp/pull/7' }, mergeCtx(queue)),
    );
    expect(out.code).toBe('NO_GITHUB_APP');
    expect(out.error).toContain(`at ${GITHUB_APP_INSTALL_URL}, then retry`);
    expect(jobs).toHaveLength(0);
  });

  it('merges with a null id when the platform has no App configured', async () => {
    fakeHub({ ok: false, code: 'github_app_not_configured' });
    const { queue, calls: jobs } = fakeQueue();
    const out = parse(
      await merge.handler({ prUrl: 'https://github.com/redbtn-io/webapp/pull/7' }, mergeCtx(queue)),
    );
    expect(out.merged).toBe(true);
    expect(jobs[0].data.githubInstallationId).toBeNull();
  });
});
