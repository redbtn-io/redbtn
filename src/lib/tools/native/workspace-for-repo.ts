/**
 * workspace_for_repo — find or create the managed workspace for a repository.
 *
 * A managed workspace is one repository at one base branch; its name is the
 * deterministic `github.com/<owner>/<repo>@<branch>` under the run's user, so
 * every dispatch for that repository lands in the same workspace and the
 * trunk working copy is retained between runs. Returns the workspaceId the
 * producer (`acquireWorkspaceForStep`) needs on `state.data.workspaceId`.
 */
import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { WorkspaceRepository } from '../../workspaces/WorkspaceRepository';
import { toolOk, toolError, resolveWorkspaceDb, resolveRunUserId, normalizeGithubRepo, BRANCH_RE } from './workspace-common';

type AnyObject = Record<string, any>;

const tool: NativeToolDefinition = {
  description:
    'Find or create the managed workspace for a GitHub repository at a base branch. ' +
    'Returns {workspaceId, name, gitRepoUrl, gitBranch, created}. Put workspaceId on state.data.workspaceId ' +
    'so the next neuron step runs inside that workspace (the repository is checked out at /workspace).',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'GitHub repository as owner/name or a github.com URL' },
      branch: { type: 'string', description: 'Base branch to check out (default "main")' },
      name: { type: 'string', description: 'Override the workspace name (default github.com/<owner>/<repo>@<branch>)' },
    },
    required: ['repo'],
  },
  handler: async (args: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const repo = normalizeGithubRepo(args?.repo);
    if (!repo) return toolError('repo must be owner/name or a github.com repository URL');
    const branch = String(args?.branch || 'main').trim();
    if (!BRANCH_RE.test(branch)) return toolError('branch is not a valid git branch name');
    const userId = resolveRunUserId(context);
    if (!userId) return toolError('the run has no userId to own the workspace', 'NO_USER');
    const db = resolveWorkspaceDb(context);
    if (!db) return toolError('workspace database unavailable', 'UNAVAILABLE');

    const name = (typeof args?.name === 'string' && args.name.trim()) || `github.com/${repo.owner}/${repo.repo}@${branch}`;
    try {
      const repository = new WorkspaceRepository(db as any);
      let ws = await repository.findByName(userId, name);
      let created = false;
      if (!ws) {
        ws = await repository.createWorkspace({
          userId,
          name,
          description: `Managed workspace for ${repo.owner}/${repo.repo} (${branch})`,
          config: { gitRepoUrl: repo.url, gitBranch: branch },
        });
        created = true;
      }
      return toolOk({
        workspaceId: ws.workspaceId,
        name,
        gitRepoUrl: ws.config?.gitRepoUrl || repo.url,
        gitBranch: ws.config?.gitBranch || branch,
        created,
      });
    } catch (err: unknown) {
      return toolError(`workspace_for_repo failed: ${err instanceof Error ? err.message : String(err)}`, 'FAILED');
    }
  },
};

export default tool;
module.exports = tool;
