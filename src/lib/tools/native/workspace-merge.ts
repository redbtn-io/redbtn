/**
 * workspace_merge — wait for a pull request's checks and merge it when green.
 *
 * Pure GitHub API on the worker side (global lifecycle queue, no container),
 * with the platform's App token. Bounded; returns {merged:false, checks,
 * failing?} rather than guessing. Intended for a deterministic graph step
 * after the agent has shipped, so no model is in the loop for the merge.
 */
import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { WORKSPACE_QUEUE } from '../../workspaces/WorkspaceLifecycle';
import { toolOk, toolError, resolveLifecycleQueue, resolveRunUserId, resolveJobInstallation } from './workspace-common';

type AnyObject = Record<string, any>;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_TIMEOUT_MS = 40 * 60 * 1000;

const tool: NativeToolDefinition = {
  description:
    'Wait for a GitHub pull request\'s checks and merge it (squash) when they pass. ' +
    'Returns {merged, mergedSha?, checks: success|failure|pending|none|closed, failing?, reason?}.',
  inputSchema: {
    type: 'object',
    properties: {
      prUrl: { type: 'string', description: 'https://github.com/<owner>/<repo>/pull/<n>' },
      timeoutMs: { type: 'number', description: 'How long to wait for checks (default 20 min, max 40)' },
      mergeMethod: { type: 'string', enum: ['squash', 'merge', 'rebase'], description: 'Default squash' },
    },
    required: ['prUrl'],
  },
  handler: async (args: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const prUrl = String(args?.prUrl || '').trim();
    const pr = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+/.exec(prUrl);
    if (!pr) {
      return toolError('prUrl must be a github.com pull request URL');
    }
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(args?.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const mergeMethod = ['squash', 'merge', 'rebase'].includes(String(args?.mergeMethod)) ? String(args.mergeMethod) : 'squash';
    const ownerUserId = resolveRunUserId(context);
    // Merging is a write on the repository, so it needs this user's own App
    // installation too — the pull request names the repo the token must cover.
    const { githubInstallationId, error } = await resolveJobInstallation(ownerUserId, `${pr[1]}/${pr[2]}`);
    if (error) return error;
    try {
      const result = await resolveLifecycleQueue(context).runJob(
        WORKSPACE_QUEUE,
        'merge',
        { action: 'merge', prUrl, ownerUserId, timeoutMs, mergeMethod, githubInstallationId },
        timeoutMs + 60 * 1000
      );
      return toolOk(result ?? { ok: false });
    } catch (err: unknown) {
      return toolError(`workspace_merge failed: ${err instanceof Error ? err.message : String(err)}`, 'FAILED');
    }
  },
};

export default tool;
module.exports = tool;
