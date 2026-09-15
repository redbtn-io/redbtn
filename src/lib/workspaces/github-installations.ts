/**
 * Which GitHub App INSTALLATION may touch this repository, for this user.
 *
 * The PLATFORM owns the "Red by redbtn" App — its id and its private key. A
 * user owns nothing but an INSTALLATION of it: they install the App on their
 * account or org and grant it the repositories an agent may touch. So the only
 * per-tenant fact is an installation id, and the hub (webapp) is the one place
 * that records which installation each user linked:
 *
 *   GET {WEBAPP_URL}/api/v1/internal/github/app/resolve?userId=…&repo=owner/name
 *   x-service-key: INTERNAL_SERVICE_KEY
 *     → { ok: true,  installationId, account: { login, type } }
 *     → { ok: false, code: 'not_installed' | 'not_authorized' | 'github_app_not_configured' }
 *
 * The answer rides on the lifecycle job as `githubInstallationId`, and the
 * worker mints a token for THAT installation instead of reading the workspace
 * owner's redsecrets. This is the engine half; the worker half is
 * `worker/src/lib/github-app.ts` in redrun.
 *
 * FAIL-OPEN, DELIBERATELY. A hub that cannot answer — it is cold, it has no
 * App configured, the key is missing — returns `installationId: null` with a
 * code, and every caller carries on with a null field. The worker then falls
 * back to the path it has always used (the owner's own secrets, then the
 * allowlisted platform fallback), which is what keeps the platform's own
 * workspaces working while users are still linking their installations. Only
 * `not_installed` / `not_authorized` are a real answer — that user has no
 * installation that can reach that repository — and those are the two the
 * shipping tools turn into an error the model can act on.
 *
 * @module lib/workspaces/github-installations
 */
import { resolveWebappBase } from '../permissions/persist-denial.js';

/** Where a user installs the App. Shown verbatim in the tools' error message. */
export const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/red-by-redbtn/installations/new';

/** The hub's own codes, plus the one this module invents when it cannot ask. */
export type GithubInstallationCode =
  | 'not_installed'
  | 'not_authorized'
  | 'github_app_not_configured'
  | 'resolver_unavailable';

export interface GithubInstallationResolution {
  /** The installation to mint a token for, or null when there is no answer. */
  installationId: number | null;
  /** Why there is no installation id. Absent on success. */
  code?: GithubInstallationCode;
  /** Who the installation belongs to, when the hub said. */
  account?: { login: string; type: string };
}

/** The hub must answer quickly; a slow hub must not hold a run's ship open. */
const RESOLVE_TIMEOUT_MS = 5000;

/**
 * `owner/name` for the resolver query, from any form a workspace records.
 *
 * Deliberately local: `normalizeGithubRepo` lives in the tool layer, and
 * importing it here would close a cycle back through `WorkspaceLifecycle`.
 */
export function repoSlug(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  const m =
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw) ||
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/.exec(raw) ||
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
  if (!m) return null;
  const [, owner, repo] = m;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return `${owner}/${repo}`;
}

/**
 * The error a shipping tool returns when the user has no installation that can
 * reach the repository. It names the repository and the one link that fixes it,
 * because the model is going to relay this sentence to a person.
 */
export function githubInstallMessage(repo: string, code: 'not_installed' | 'not_authorized'): string {
  const why =
    code === 'not_authorized'
      ? `the Red by redbtn App is installed, but ${repo} is not one of the repositories it was granted`
      : `no Red by redbtn App installation can reach ${repo}`;
  return `${why}. Install the Red by redbtn App for ${repo} at ${GITHUB_APP_INSTALL_URL}, then retry`;
}

/** True for the two codes that mean "the user must go install something". */
export function isMissingInstallation(
  code: GithubInstallationCode | undefined,
): code is 'not_installed' | 'not_authorized' {
  return code === 'not_installed' || code === 'not_authorized';
}

/**
 * Ask the hub which installation covers `gitRepoUrl` for `userId`.
 *
 * Never throws: every failure is a `{ installationId: null, code }`, so a
 * caller can decide between refusing (a real "not installed") and carrying on
 * with a null field (anything else). See the fail-open note at the top.
 */
export async function resolveGithubInstallation(
  userId: string | undefined | null,
  gitRepoUrl: string | undefined | null,
): Promise<GithubInstallationResolution> {
  const user = String(userId ?? '').trim();
  const repo = repoSlug(gitRepoUrl);
  const base = resolveWebappBase();
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  // Nothing to ask with, or nobody to ask: the worker's own resolution stands.
  if (!user || !repo || !base || !serviceKey) {
    return { installationId: null, code: 'resolver_unavailable' };
  }

  const url =
    `${base}/api/v1/internal/github/app/resolve` +
    `?userId=${encodeURIComponent(user)}&repo=${encodeURIComponent(repo)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'x-service-key': serviceKey },
      signal: controller.signal,
    });
    if (!res.ok) return { installationId: null, code: 'resolver_unavailable' };
    const body = (await res.json()) as {
      ok?: boolean;
      installationId?: number | string;
      account?: { login: string; type: string };
      code?: GithubInstallationCode;
    };
    if (body?.ok === true) {
      const id = Number(body.installationId);
      // An `ok:true` with no usable id is a broken answer, not an answer.
      if (!Number.isFinite(id) || id <= 0) return { installationId: null, code: 'resolver_unavailable' };
      return { installationId: id, ...(body.account ? { account: body.account } : {}) };
    }
    const code: GithubInstallationCode =
      body?.code === 'not_installed' || body?.code === 'not_authorized' || body?.code === 'github_app_not_configured'
        ? body.code
        : 'resolver_unavailable';
    return { installationId: null, code };
  } catch {
    // Network error, abort, malformed JSON — the hub did not answer.
    return { installationId: null, code: 'resolver_unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
