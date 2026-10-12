/**
 * Dispatch-time address resolution for the `workspace` tools.
 *
 * The capability gate is synchronous, but which workspace a workspace tool
 * targets can depend on the run (its checkouts, the pull requests it shipped)
 * or on Mongo (an existing workspace's id). The native-tool chokepoint calls
 * `resolveWorkspaceToolAddress` for rules marked `asyncResolve: 'workspace'`
 * and hands the result to `enforceToolCapability`.
 *
 *   workspace_for_repo  the workspace it finds, by its CONFIGURED repo/branch
 *                       (+ its ws_ id); else the repo/branch it would create.
 *   workspace_ship      the identities of THIS run's checkout running in the
 *                       pinned environmentId — recorded by the producer, or
 *                       verified in Mongo (an active checkout with this runId).
 *                       Unknown checkout -> unscoped (needs a '*' grant).
 *   workspace_merge     owner/repo of the PR; when this run shipped that PR,
 *                       also owner/repo@<PR base> and — when the PR targets the
 *                       workspace's own base branch — the workspace's identities.
 *
 * Never throws: a lookup failure leaves the synchronous address in place,
 * which can only be NARROWER (fewer identities to match), never wider.
 *
 * @module lib/permissions/workspace-address
 */
import type { NativeToolContext } from '../tools/native-registry';
import { getDataToolRule, type ExtractedAddress } from './tool-map';
import {
  findShippedPullRequest,
  findWorkspaceCheckoutByEnv,
  workspaceAliases,
} from './workspace-grants';
import { WorkspaceRepository } from '../workspaces/WorkspaceRepository';
import { resolveWorkspaceDb, resolveRunUserId, normalizeGithubRepo } from '../tools/native/workspace-common';
import { readWorkspaceTaskState } from '../workspaces/workspace-task-contract';

type AnyObject = Record<string, any>;

function runIdOf(context: NativeToolContext | undefined): string | null {
  const id = context?.runId || context?.state?.runId || context?.state?.data?.runId;
  return typeof id === 'string' && id ? id : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

async function forRepo(base: ExtractedAddress, args: AnyObject, context: NativeToolContext): Promise<ExtractedAddress> {
  if (base.unscoped) return base;
  // Mirrors the tool: the workspace is looked up by its exact name, by default
  // `github.com/<owner>/<repo>@<branch>` with the repo's case preserved.
  const parsed = normalizeGithubRepo(args.repo);
  const branch = str(args.branch) || 'main';
  const name = str(args.name) || (parsed ? `github.com/${parsed.owner}/${parsed.repo}@${branch}` : '');
  try {
    const userId = resolveRunUserId(context);
    const db = resolveWorkspaceDb(context);
    if (userId && db && name) {
      const ws = await new WorkspaceRepository(db as any).findByName(userId, name);
      if (ws?.workspaceId) {
        // An existing workspace is the target: judge it by what it IS (its
        // configured repo and branch), not by what the call claims — a name
        // override must not borrow another repository's workspace.
        const aliases = workspaceAliases({
          workspaceId: ws.workspaceId,
          repo: ws.config?.gitRepoUrl,
          branch: ws.config?.gitBranch,
        });
        return { addresses: [aliases[0]], anyOf: aliases };
      }
    }
  } catch {
    /* lookup failure: judge the call by the workspace it would create */
  }
  // A NEW workspace is judged by the repo and branch it will be created
  // with — never by `args.name`, a free-form label (see WorkspaceIdentity).
  const aliases = [...(base.anyOf ?? base.addresses)];
  return { addresses: [base.addresses[0] ?? aliases[0]], anyOf: aliases };
}

async function forShip(args: AnyObject, context: NativeToolContext): Promise<ExtractedAddress> {
  const runId = runIdOf(context);
  const stateWs = context?.state?.data?.ws as AnyObject | undefined;
  const environmentId = str(args.environmentId) || str(stateWs?.environmentId);
  if (!runId || !environmentId) return { addresses: [], unscoped: true };

  const recorded = findWorkspaceCheckoutByEnv(runId, environmentId);
  if (recorded) {
    // The handler pushes the checkout named on state.data.ws; it must be the
    // one the engine recorded for this environment, or nothing is trusted.
    if (stateWs?.workspaceId && stateWs.workspaceId !== recorded.workspaceId) {
      return { addresses: [], unscoped: true };
    }
    return { addresses: [recorded.aliases[0]], anyOf: recorded.aliases };
  }

  // Not recorded in this process (e.g. a retried step on another worker):
  // trust only a checkout Mongo says THIS run holds in that environment.
  try {
    const db = resolveWorkspaceDb(context);
    if (db) {
      const doc = await (db as any)
        .collection('agentWorkspaces')
        .findOne(
          { activeCheckouts: { $elemMatch: { environmentId, runId } } },
          { projection: { workspaceId: 1, config: 1 } },
        );
      if (doc?.workspaceId) {
        if (stateWs?.workspaceId && stateWs.workspaceId !== doc.workspaceId) return { addresses: [], unscoped: true };
        const aliases = workspaceAliases({
          workspaceId: doc.workspaceId,
          repo: doc.config?.gitRepoUrl,
          branch: doc.config?.gitBranch,
        });
        return { addresses: [aliases[0]], anyOf: aliases };
      }
    }
  } catch {
    /* fall through: unscoped */
  }
  return { addresses: [], unscoped: true };
}

function forMerge(base: ExtractedAddress, args: AnyObject, context: NativeToolContext): ExtractedAddress {
  if (base.unscoped) return base;
  const repo = (base.anyOf ?? base.addresses).find((a) => !a.startsWith('github.com/')) ?? '';
  const shipped = findShippedPullRequest(runIdOf(context), args.prUrl);
  if (!shipped || shipped.repo !== repo) return base;
  const aliases = [`github.com/${repo}`, repo];
  if (shipped.base) aliases.push(`github.com/${repo}@${shipped.base.toLowerCase()}`, `${repo}@${shipped.base.toLowerCase()}`);
  // The workspace's own identities only when the PR merges into the
  // workspace's base branch: a grant on `ws_x` / `owner/repo@beta` must not
  // merge a PR that was shipped into another branch.
  if (shipped.base && shipped.workspaceBranch && shipped.base.toLowerCase() === shipped.workspaceBranch.toLowerCase()) {
    for (const a of shipped.aliases) if (!aliases.includes(a)) aliases.push(a);
  }
  return { addresses: [aliases[0]], anyOf: aliases };
}

/** workspace_get / workspace_task: the workspace named by id, with its repo identities when it exists. */
async function forWorkspaceId(base: ExtractedAddress, context: NativeToolContext): Promise<ExtractedAddress> {
  if (base.unscoped) return base;
  const workspaceId = base.addresses[0];
  try {
    const db = resolveWorkspaceDb(context);
    if (db) {
      const ws = await new WorkspaceRepository(db as any).getWorkspace(workspaceId);
      if (ws?.workspaceId === workspaceId) {
        const aliases = workspaceAliases({
          workspaceId,
          repo: ws.config?.gitRepoUrl,
          branch: ws.config?.gitBranch,
        });
        return { addresses: [workspaceId], anyOf: aliases };
      }
    }
  } catch {
    /* the id alone */
  }
  return base;
}

/** get_workspace_task: the workspace the task run works in (from its run state, else its checkout record). */
async function forTaskRun(args: AnyObject, context: NativeToolContext): Promise<ExtractedAddress> {
  const runId = str(args.runId);
  if (!runId) return { addresses: [], unscoped: true };
  let workspaceId = '';
  const rs = await readWorkspaceTaskState(context, runId);
  if (rs) workspaceId = str(rs.input?.workspaceId);
  if (!workspaceId) {
    try {
      const db = resolveWorkspaceDb(context);
      const ws = db
        ? await (db as any)
            .collection('agentWorkspaces')
            .findOne(
              { $or: [{ 'activeCheckouts.runId': runId }, { 'checkoutHistory.runId': runId }] },
              { projection: { workspaceId: 1 } },
            )
        : null;
      workspaceId = str(ws?.workspaceId);
    } catch {
      /* unscoped */
    }
  }
  if (!workspaceId) return { addresses: [], unscoped: true };
  return forWorkspaceId({ addresses: [workspaceId], anyOf: [workspaceId] }, context);
}

/**
 * The resolved address of a workspace tool call, or null when `toolName` is
 * not a workspace tool (the gate then uses the rule's own `extract`).
 */
export async function resolveWorkspaceToolAddress(
  toolName: string,
  args: AnyObject,
  context: NativeToolContext,
): Promise<ExtractedAddress | null> {
  const rule = getDataToolRule(toolName);
  if (!rule || rule.asyncResolve !== 'workspace') return null;
  const safeArgs = args ?? {};
  const base = rule.extract(safeArgs);
  switch (toolName) {
    case 'workspace_for_repo':
      return forRepo(base, safeArgs, context);
    case 'workspace_ship':
      return forShip(safeArgs, context);
    case 'workspace_merge':
      return forMerge(base, safeArgs, context);
    case 'workspace_get':
    case 'workspace_task':
      return forWorkspaceId(base, context);
    case 'get_workspace_task':
      return forTaskRun(safeArgs, context);
    default:
      return base;
  }
}
