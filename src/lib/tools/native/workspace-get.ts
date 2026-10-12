/**
 * workspace_get — read one managed workspace: its configuration, the
 * checkouts active right now (branch, run, environment, PR) and its recent
 * ships. Changes nothing.
 *
 * Gated `workspace:read`, addressed by the workspace (ws_ id plus its repo
 * identities — see permissions/workspace-grants.ts). Only the run's user (the
 * CALLER on a delegated run) can see their own workspaces; anything else is
 * reported as not found, never as "forbidden", so ids cannot be probed.
 */
import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { WorkspaceRepository } from '../../workspaces/WorkspaceRepository';
import { toolOk, toolError, resolveWorkspaceDb, resolveRunUserId } from './workspace-common';

type AnyObject = Record<string, any>;

const MAX_HISTORY = 10;

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function prOf(entry: AnyObject | undefined): AnyObject | null {
  const pr = entry?.pr;
  if (!pr || typeof pr !== 'object') return null;
  const out: AnyObject = {};
  if (typeof pr.url === 'string') out.url = pr.url;
  if (typeof pr.mergedSha === 'string') out.mergedSha = pr.mergedSha;
  return Object.keys(out).length ? out : null;
}

const tool: NativeToolDefinition = {
  description:
    'Read one managed workspace (a GitHub repository at a base branch): its configuration, the checkouts active right now ' +
    '(checkoutKey, branch, runId, environmentId, PR, lease expiry) and its recent ships. Changes nothing. ' +
    'Returns {workspaceId, name, repo, baseBranch, activeCheckouts[], recentShips[]}.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'The workspace id (ws_...).' },
    },
    required: ['workspaceId'],
  },
  handler: async (args: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const workspaceId = typeof args?.workspaceId === 'string' ? args.workspaceId.trim() : '';
    if (!workspaceId) return toolError('workspaceId is required');
    const userId = resolveRunUserId(context);
    if (!userId) return toolError('the run has no userId', 'NO_USER');
    const db = resolveWorkspaceDb(context);
    if (!db) return toolError('workspace database unavailable', 'UNAVAILABLE');
    try {
      const ws: AnyObject | null = await new WorkspaceRepository(db as any).getWorkspace(workspaceId);
      if (!ws || ws.userId !== userId) return toolError(`workspace ${workspaceId} not found`, 'NOT_FOUND');
      const now = Date.now();
      const activeCheckouts = (Array.isArray(ws.activeCheckouts) ? ws.activeCheckouts : [])
        .filter((c: AnyObject) => c && new Date(c.leaseExpiresAt).getTime() > now)
        .map((c: AnyObject) => ({
          checkoutId: c.checkoutId ?? null,
          checkoutKey: c.checkoutKey ?? null,
          mode: c.mode ?? null,
          branch: c.branch ?? null,
          runId: c.runId ?? null,
          environmentId: c.environmentId ?? null,
          pr: prOf(c),
          checkedOutAt: iso(c.checkedOutAt ?? c.createdAt),
          leaseExpiresAt: iso(c.leaseExpiresAt),
        }));
      const history: AnyObject[] = Array.isArray(ws.checkoutHistory) ? ws.checkoutHistory : [];
      const recentShips = history
        .filter((h) => prOf(h))
        .slice(-MAX_HISTORY)
        .reverse()
        .map((h) => ({
          checkoutKey: h.checkoutKey ?? null,
          branch: h.branch ?? null,
          runId: h.runId ?? null,
          pr: prOf(h),
          releasedAt: iso(h.releasedAt ?? h.endedAt),
        }));
      return toolOk({
        workspaceId: ws.workspaceId,
        name: ws.name ?? null,
        repo: ws.config?.gitRepoUrl ?? null,
        baseBranch: ws.config?.gitBranch ?? null,
        status: ws.status ?? null,
        activeCheckouts,
        recentShips,
      });
    } catch (err: unknown) {
      return toolError(`workspace_get failed: ${err instanceof Error ? err.message : String(err)}`, 'FAILED');
    }
  },
};

export default tool;
module.exports = tool;
