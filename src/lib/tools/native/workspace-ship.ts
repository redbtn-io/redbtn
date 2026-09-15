/**
 * workspace_ship — push the workspace's committed work as a branch and open
 * the pull request, from inside a run that holds a managed workspace.
 *
 * The container never holds a GitHub credential. This asks the node that
 * owns the working copy (its redrun worker) to push with the platform's
 * GitHub App token and open (or find) the PR. The bridge pins
 * `environmentId` to the run's workspace environment, so the capability jail
 * scopes this exactly like run_command.
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
  BRANCH_RE,
} from './workspace-common';

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
      base: { type: 'string', description: 'Base branch (defaults to the workspace base branch)' },
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
    try {
      const workspace = await new WorkspaceRepository(db as any).getWorkspace(ws.workspaceId);
      if (!workspace) return toolError(`workspace ${ws.workspaceId} not found`, 'NOT_FOUND');
      const gitRepoUrl = workspace.config?.gitRepoUrl;
      if (!gitRepoUrl) return toolError('this workspace has no repository configured', 'NO_REPO');
      // The push needs a token for THIS owner's App installation.
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
          base: (typeof args?.base === 'string' && args.base.trim()) || workspace.config?.gitBranch || 'main',
          gitRepoUrl,
          ownerUserId: workspace.userId,
          githubInstallationId,
        },
        PUSH_TIMEOUT_MS
      );
      return toolOk(result ?? { ok: false });
    } catch (err: unknown) {
      return toolError(`workspace_ship failed: ${err instanceof Error ? err.message : String(err)}`, 'FAILED');
    }
  },
};

export default tool;
module.exports = tool;
