/**
 * Shared plumbing for the managed-workspace tools (`workspace_for_repo`,
 * `workspace_ship`, `workspace_merge`).
 */
import type { NativeToolContext, NativeMcpResult } from '../native-registry';
import { bullLifecycleQueue, type LifecycleQueue } from '../../workspaces/WorkspaceLifecycle';
import {
  resolveGithubInstallation,
  isMissingInstallation,
  githubInstallMessage,
  repoSlug,
} from '../../workspaces/github-installations';

type AnyObject = Record<string, any>;

export function toolOk(payload: AnyObject): NativeMcpResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function toolError(message: string, code = 'VALIDATION'): NativeMcpResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message, code }) }], isError: true };
}

/** The run's Mongo handle: an injected one (tests) or the live mongoose connection. */
export function resolveWorkspaceDb(context: NativeToolContext): AnyObject | null {
  if (context?.state?.workspaceDb) return context.state.workspaceDb;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mongoose = require('mongoose');
    if (mongoose?.connection?.readyState === 1 && mongoose.connection.db) return mongoose.connection.db;
  } catch {
    /* mongoose unavailable */
  }
  return null;
}

/** The lifecycle queue: an injected one (tests) or BullMQ. */
export function resolveLifecycleQueue(context: NativeToolContext): LifecycleQueue {
  return (context?.state?.workspaceQueue as LifecycleQueue | undefined) || bullLifecycleQueue;
}

export function resolveRunUserId(context: NativeToolContext): string | null {
  const s = context?.state;
  const id = s?.data?.userId || s?.userId || s?.data?.options?.userId;
  return typeof id === 'string' && id ? id : null;
}

/** `owner/name`, a github.com URL, or an ssh remote → canonical parts + clone URL. */
export function normalizeGithubRepo(input: unknown): { owner: string; repo: string; url: string } | null {
  const raw = String(input ?? '').trim();
  const m =
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw) ||
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw) ||
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
  if (!m) return null;
  const [, owner, repo] = m;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;

/**
 * The App installation to put on a GitHub-facing job — or the error to return.
 *
 * Both shipping tools do the same two things with the hub's answer. When it
 * says this user has no installation that can reach the repository, they refuse
 * and say how to fix it: the push or merge would fail on GitHub anyway, and
 * only a person can install the App. Every other answer (the hub is cold, the
 * platform has no App configured) carries on with a null id, which leaves the
 * worker on the path it has always used. Shared so the two tools cannot drift
 * into two different sentences.
 */
export async function resolveJobInstallation(
  userId: string | null | undefined,
  repo: string
): Promise<{ githubInstallationId: number | null; error?: NativeMcpResult }> {
  const installation = await resolveGithubInstallation(userId, repo);
  if (isMissingInstallation(installation.code)) {
    return {
      githubInstallationId: null,
      error: toolError(githubInstallMessage(repoSlug(repo) ?? repo, installation.code), 'NO_GITHUB_APP'),
    };
  }
  return { githubInstallationId: installation.installationId };
}
