/**
 * workspace_ship — push the workspace's committed work as a branch and open
 * the pull request, from inside a run that holds a managed workspace.
 *
 * The container never holds a GitHub credential. This asks the node that
 * owns the working copy (its redrun worker) to push with the platform's
 * GitHub App token and open (or find) the PR. The bridge pins
 * `environmentId` to the run's workspace environment; the capability gate
 * (`workspace:write`, 0.0.296) addresses the call by the workspace whose
 * checkout runs in that environment — see permissions/workspace-address.ts.
 */
import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { WorkspaceRepository } from '../../workspaces/WorkspaceRepository';
import { workspaceNodeQueue } from '../../workspaces/WorkspaceLifecycle';
import {
  toolOk,
  toolError,
  resolveWorkspaceDb,
  resolveLifecycleQueue,
  resolveJobInstallation,
  resolveDelegatedFromUserId,
  noteShippedPullRequest,
  BRANCH_RE,
} from './workspace-common';

import { recordShippedPullRequest, workspaceAliases, repoSlug, decideShipBase } from '../../permissions/workspace-grants';
import { getCapabilityProfile } from '../../run/contextLookup';
import { persistDenial } from '../../permissions/persist-denial';
import { CapabilityDeniedError } from '../../permissions/types';

type AnyObject = Record<string, any>;
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;

const tool: NativeToolDefinition = {
  description:
    'Push the committed work in /workspace to a branch on GitHub and open a pull request into the base branch. ' +
    'Commit first (git add / git commit); this pushes HEAD. Returns {prUrl, prNumber, branch, headSha, created}. ' +
    'The platform merges the PR after its checks pass; you do not merge.',
  inputSchema: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: 'Remote branch name to push HEAD to (e.g. red/fix-login-redirect)' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request description (markdown)' },
      base: { type: 'string', description: 'Base branch (defaults to the workspace base branch; another branch needs a write grant naming it)' },
      environmentId: { type: 'string', description: 'Pinned by the platform; do not set' },
    },
    required: ['branch', 'title'],
  },
  handler: async (args: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const ws = context?.state?.data?.ws;
    if (!ws?.workspaceId || !ws?.checkoutId || !ws?.nodeId) {
      return toolError('this run holds no managed workspace checkout (nothing to ship)', 'NO_WORKSPACE');
    }
    const branch = String(args?.branch || '').trim();
    if (!BRANCH_RE.test(branch)) return toolError('branch is not a valid git branch name');
    const title = String(args?.title || '').trim();
    if (!title) return toolError('title is required');
    const db = resolveWorkspaceDb(context);
    if (!db) return toolError('workspace database unavailable', 'UNAVAILABLE');
    const delegatedFromUserId = resolveDelegatedFromUserId(context);
    try {
      const workspace = await new WorkspaceRepository(db as any).getWorkspace(ws.workspaceId);
      if (!workspace) return toolError(`workspace ${ws.workspaceId} not found`, 'NOT_FOUND');
      const gitRepoUrl = workspace.config?.gitRepoUrl;
      if (!gitRepoUrl) return toolError('this workspace has no repository configured', 'NO_REPO');
      // The PR's base. Into the workspace's own base branch, the dispatch
      // gate's workspace:write on the workspace is enough; into any OTHER
      // branch (e.g. `main` from a `beta` workspace) the profile must grant
      // workspace:write on `<o>/<r>@<base>` itself (decideShipBase). Checked
      // before anything is pushed.
      const configuredBase: string = (typeof workspace.config?.gitBranch === 'string' && workspace.config.gitBranch.trim()) || 'main';
      const base = (typeof args?.base === 'string' && args.base.trim()) || configuredBase;
      if (base !== configuredBase) {
        if (!BRANCH_RE.test(base)) return toolError('base is not a valid git branch name');
        const profile = getCapabilityProfile(context?.state);
        if (profile) {
          const decision = decideShipBase(profile, { repo: gitRepoUrl, configuredBase }, base);
          if (!decision.allowed) {
            persistDenial(
              context,
              'workspace_ship',
              new CapabilityDeniedError({
                resource: 'workspace',
                action: 'write',
                address: decision.address ?? base,
                profileName: profile.name ?? 'unnamed-profile',
                message: decision.reason ?? 'Permission denied.',
              }),
            );
            return toolError(decision.reason ?? `opening a pull request into '${base}' is not allowed`, 'FORBIDDEN');
          }
        }
      }
      // The push needs a token for THIS owner's App installation. On a
      // delegated run the workspace was created under the CALLER
      // (`workspace_for_repo` → `resolveRunUserId`), so `workspace.userId` is
      // already the caller and this resolves the caller's installation — no
      // second identity decision to get wrong here.
      const { githubInstallationId, error } = await resolveJobInstallation(workspace.userId, gitRepoUrl);
      if (error) return error;
      const result = await resolveLifecycleQueue(context).runJob(
        workspaceNodeQueue(String(ws.nodeId)),
        'push',
        {
          action: 'push',
          workspaceId: ws.workspaceId,
          checkoutId: ws.checkoutId,
          mode: ws.mode || 'exclusive',
          checkoutKey: ws.checkoutKey || 'trunk',
          branch,
          title,
          body: typeof args?.body === 'string' ? args.body : '',
          base,
          gitRepoUrl,
          ownerUserId: workspace.userId,
          githubInstallationId,
          // Audit only — whose automation delegated this run, when it was
          // delegated at all. Nothing on the worker resolves against it.
          ...(delegatedFromUserId ? { delegatedFromUserId } : {}),
        },
        PUSH_TIMEOUT_MS
      );
      // The pull request is known here and nowhere else. Parked on the active
      // checkout, the release copies it into the workspace's history, so the
      // detail page can say what this run shipped. Never fatal: the push
      // already happened, and a bookkeeping failure must not report it as one.
      await noteShippedPullRequest(context, ws, { prUrl: result?.prUrl });
      // Remember the PR for the capability gate: a later workspace_merge of
      // it in this run is also addressed by this workspace when the PR targets
      // the workspace's base branch, so `workspace:control` on the workspace
      // covers merging what the run itself shipped into its base. See
      // permissions/workspace-address.ts.
      if (result?.prUrl) {
        recordShippedPullRequest(context?.runId || context?.state?.runId || context?.state?.data?.runId, result.prUrl, {
          workspaceId: ws.workspaceId,
          aliases: workspaceAliases({
            workspaceId: ws.workspaceId,
            repo: gitRepoUrl,
            branch: workspace.config?.gitBranch,
          }),
          repo: repoSlug(gitRepoUrl),
          base,
          workspaceBranch: configuredBase,
        });
      }
      return toolOk(result ?? { ok: false });
    } catch (err: unknown) {
      return toolError(`workspace_ship failed: ${err instanceof Error ? err.message : String(err)}`, 'FAILED');
    }
  },
};

export default tool;
module.exports = tool;
