/**
 * Shared plumbing for the managed-workspace tools (`workspace_for_repo`,
 * `workspace_ship`, `workspace_merge`).
 */
import type { NativeToolContext, NativeMcpResult } from '../native-registry';
import { bullLifecycleQueue, type LifecycleQueue } from '../../workspaces/WorkspaceLifecycle';
import { WorkspaceRepository } from '../../workspaces/WorkspaceRepository';
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

/**
 * The identity these tools ACT AS.
 *
 * Run-as-caller delegation (docs/RUN-AS-CALLER-DELEGATION-SPEC.md): an
 * automation declared `executionIdentity:'caller'` + `callerInvokable` is
 * triggered by somebody who is not its owner, the hub puts that VERIFIED
 * caller on the run, and `buildInitialState` mirrors it onto state as
 * `callerUserId` (top level and `data.callerUserId`). The spec's rule is that
 * CONNECTIONS, ENVIRONMENTS and SECRETS resolve as the caller while LLM access,
 * tier gating and metering stay on the owner.
 *
 * A managed workspace is squarely on the caller's side of that line: it is a
 * checkout of the caller's repository, reached with the caller's GitHub App
 * installation, on a container that runs the caller's code. Before this
 * preferred `callerUserId`, a delegated board dispatch found or created the
 * OWNER's workspace and asked the hub for the OWNER's installation, so the run
 * shipped with the owner's repositories and credentials — the exact inversion
 * the spec exists to prevent. Same precedence as ssh_shell / ssh_tail /
 * ssh_kill, which already read `state.callerUserId || state.userId`.
 *
 * Undelegated runs have no `callerUserId` and fall through to the owner chain,
 * so nothing about a normal run changes.
 */
export function resolveRunUserId(context: NativeToolContext): string | null {
  const s = context?.state;
  const caller = s?.callerUserId || s?.data?.callerUserId;
  if (typeof caller === 'string' && caller) return caller;
  return resolveRunOwnerUserId(context);
}

/**
 * The run OWNER — the automation's owner on a delegated run, and the same
 * person as the caller on every other one.
 *
 * Deliberately NOT caller-aware: this is the identity the spec keeps every
 * billing-shaped decision on (tier gating, metering, redToken ledger). Use it
 * for anything that spends or records against an account, and
 * `resolveRunUserId` for anything the run reaches for on the caller's behalf.
 */
export function resolveRunOwnerUserId(context: NativeToolContext): string | null {
  const s = context?.state;
  const id = s?.data?.userId || s?.userId || s?.data?.options?.userId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * The owner to stamp on a lifecycle job as `delegatedFromUserId`, or null when
 * this run is not delegated.
 *
 * AUDIT ONLY. Nothing on the worker resolves a credential, a secret or a
 * repository against it — the job's `ownerUserId` (the caller, who owns the
 * workspace) is the only identity that decides anything. This exists so a
 * worker log line can say whose automation a caller's container came from,
 * which is otherwise unrecoverable once the job leaves the engine.
 */
export function resolveDelegatedFromUserId(context: NativeToolContext): string | null {
  const s = context?.state;
  const caller = s?.callerUserId || s?.data?.callerUserId;
  if (typeof caller !== 'string' || !caller) return null;
  const owner = resolveRunOwnerUserId(context);
  return owner && owner !== caller ? owner : null;
}

/**
 * The run OWNER's account tier, which decides the storage tier of any workspace
 * this run creates (see `lib/workspaces/tiers.ts`). The run path already put it
 * on state as `data.accountTier`; without it a managed workspace created for a
 * paying account would be provisioned as Free.
 *
 * Stays the OWNER's tier on a delegated run, and deliberately so: the storage
 * this workspace consumes is billed to the account whose automation asked for
 * it, and tier gating is one of the three things
 * docs/RUN-AS-CALLER-DELEGATION-SPEC.md keeps on the owner. The caller decides
 * WHICH repository is checked out; the owner's plan decides how much of it is
 * kept.
 */
export function resolveRunAccountTier(context: NativeToolContext): number | undefined {
  const tier = context?.state?.data?.accountTier;
  return typeof tier === 'number' && Number.isFinite(tier) ? tier : undefined;
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
 *
 * `userId` is the CALLER on a delegated run (the workspace's owner), never the
 * automation's owner: an installation is a credential, and a delegated run
 * reaches GitHub as the person who triggered it. A caller with no installation
 * gets NO_GITHUB_APP even when the owner has one — borrowing the owner's
 * installation would hand the caller's agent every repository the owner
 * granted.
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

/**
 * Remember, on the run's own checkout, the pull request it just produced.
 *
 * `workspace_ship` learns the PR url and `workspace_merge` the merged sha, each
 * once, mid-checkout. The workspace's release copies whatever is on the
 * checkout into its history entry, which is the only place a person can later
 * see that this workspace ran and what came out of it.
 *
 * Deliberately swallows everything. Both callers have already done the thing
 * the user asked for by the time this runs — the branch is pushed, the PR is
 * merged — and a failed note is a missing line in a history, not a failed ship.
 */
export async function noteShippedPullRequest(
  context: NativeToolContext,
  ws: AnyObject | null | undefined,
  pr: { prUrl?: unknown; mergedSha?: unknown }
): Promise<void> {
  const workspaceId = typeof ws?.workspaceId === 'string' ? ws.workspaceId : null;
  const checkoutId = typeof ws?.checkoutId === 'string' ? ws.checkoutId : null;
  const prUrl = typeof pr.prUrl === 'string' ? pr.prUrl : null;
  const mergedSha = typeof pr.mergedSha === 'string' ? pr.mergedSha : null;
  if (!workspaceId || !checkoutId || (!prUrl && !mergedSha)) return;

  try {
    const db = resolveWorkspaceDb(context);
    if (!db) return;
    await new WorkspaceRepository(db as any).noteCheckoutShip(workspaceId, checkoutId, {
      prUrl,
      mergedSha,
    });
  } catch (err: unknown) {
    console.warn(
      '[workspace] could not record the pull request on the checkout:',
      err instanceof Error ? err.message : String(err)
    );
  }
}
