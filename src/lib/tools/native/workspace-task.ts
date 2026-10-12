/**
 * workspace_task — start a worker run that checks a managed workspace out and
 * does one task in it, and return at once.
 *
 * The calling operator never runs inside a checkout. This starts a CHILD run
 * of the platform worker graph `workspace-task` (ops/workspace-task/) AS THE
 * CALLER (the parent's owner, with the parent's run-as-caller delegation) and
 * returns `{runId, workspaceId, checkoutKey}` immediately; follow it with
 * `get_workspace_task` / `get_run`.
 *
 * Capabilities (permissions/workspace-grants.ts):
 *   - gated `workspace:execute` on the workspace (DATA_TOOL_RULES), plus
 *     `workspace:write` when `ship: true` (checked here, against the parent's
 *     effective profile) — and, when `base` is not the workspace's own base
 *     branch, `workspace:write` on `<o>/<r>@<base>` (decideShipBase);
 *   - the child runs under an ENGINE-DERIVED profile, never broader than the
 *     parent: `workspace:execute@<id>` (+ `workspace:write@<id>` only when
 *     shipping, + `workspace:write@<o>/<r>@<base>` only when shipping into a
 *     non-default base the parent may target), no `workspace:control`, no
 *     state / knowledge / exec grants —
 *     its commands run on the checkout through the derived
 *     `exec:execute@<checkout env>` its own producer adds. The override is a
 *     `run()` option that only in-process engine callers can set.
 *
 * In-process, like `invoke_graph` with wait:false: the child is a normal run
 * (own runId, run state, archive) executing in this worker. It is NOT a queued
 * job — a worker redeploy kills it like any in-flight run and nothing requeues
 * it; `get_workspace_task` then reports `interrupted` so the caller can start
 * it again.
 */
import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { WorkspaceRepository } from '../../workspaces/WorkspaceRepository';
import { toolOk, toolError, resolveWorkspaceDb, resolveRunUserId, BRANCH_RE } from './workspace-common';
import { getCapabilityProfile, getGraphRegistry, getNeuronRegistry, getMemory, getMcpClient } from '../../run/contextLookup';
import { decideWorkspace, decideShipBase, workspaceAliases } from '../../permissions/workspace-grants';
import { persistDenial } from '../../permissions/persist-denial';
import { CapabilityDeniedError } from '../../permissions/types';
import { WORKSPACE_TASK_GRAPH_ID, WORKSPACE_TASK_DEFAULT_NEURON, deriveWorkspaceTaskProfile } from '../../workspaces/workspace-task-contract';
import { MODEL_DRIVEN_STATE_KEY, isModelDrivenState } from '../caller-trust';

type AnyObject = Record<string, any>;

const MAX_BRIEF_CHARS = 20_000;
const MAX_INVOKE_DEPTH = 5;

/** Same Red-shaped duck `invoke_graph` assembles for an in-process child run. */
function buildRedShape(state: AnyObject, publisher: any): AnyObject | null {
  const redis = (publisher as any)?.redis;
  const redlog = (publisher as any)?.redlog;
  const graphRegistry = getGraphRegistry(state);
  const neuronRegistry = getNeuronRegistry(state);
  const memory = getMemory(state);
  const mcpClient = getMcpClient(state);
  if (!redis || !graphRegistry || !neuronRegistry || !memory) return null;
  return {
    redis,
    redlog,
    graphRegistry,
    neuronRegistry,
    memory,
    callMcpTool: async (toolName: string, args: Record<string, unknown>, meta?: Record<string, unknown>, signal?: AbortSignal) => {
      if (!mcpClient?.callTool) throw new Error('callMcpTool not available — parent state has no mcpClient');
      return mcpClient.callTool(toolName, args, meta, signal);
    },
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

const tool: NativeToolDefinition = {
  description:
    'Start a worker run that checks out a managed workspace and does one task in it (a coding agent working in its own ' +
    'checkout only). Returns {runId, workspaceId, checkoutKey} immediately — do not wait in a loop; check progress later ' +
    'with get_workspace_task {runId}. With ship:true the worker may push its branch and open a pull request into the base ' +
    'branch (needs workspace write permission); it never merges.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'The workspace id (ws_...).' },
      brief: { type: 'string', description: 'What the worker should do — the full task, self-contained.' },
      ship: { type: 'boolean', description: 'Push the work and open a pull request when done (default false).' },
      base: { type: 'string', description: 'Base branch for the pull request (default: the workspace base branch).' },
      neuronId: { type: 'string', description: `Worker neuron (default ${WORKSPACE_TASK_DEFAULT_NEURON}).` },
    },
    required: ['workspaceId', 'brief'],
  },
  handler: async (args: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const workspaceId = str(args?.workspaceId);
    if (!workspaceId) return toolError('workspaceId is required');
    const brief = typeof args?.brief === 'string' ? args.brief.trim() : '';
    if (!brief) return toolError('brief is required');
    if (brief.length > MAX_BRIEF_CHARS) return toolError(`brief is too long (max ${MAX_BRIEF_CHARS} characters)`);
    const ship = args?.ship === true || String(args?.ship) === 'true';
    const base = str(args?.base);
    if (base && !BRANCH_RE.test(base)) return toolError('base is not a valid git branch name');
    const neuronId = str(args?.neuronId) || WORKSPACE_TASK_DEFAULT_NEURON;

    const state: AnyObject = context?.state || {};
    const caller = resolveRunUserId(context);
    if (!caller) return toolError('the run has no userId', 'NO_USER');
    const owner: string = (typeof state.userId === 'string' && state.userId) || (state.data?.userId as string) || caller;
    const db = resolveWorkspaceDb(context);
    if (!db) return toolError('workspace database unavailable', 'UNAVAILABLE');

    // The workspace must be the caller's (the producer would refuse anyway,
    // but only after a run had been started for nothing).
    let ws: AnyObject | null = null;
    try {
      ws = await new WorkspaceRepository(db as any).getWorkspace(workspaceId);
    } catch (err) {
      return toolError(`workspace lookup failed: ${err instanceof Error ? err.message : String(err)}`, 'FAILED');
    }
    if (!ws || ws.userId !== caller) return toolError(`workspace ${workspaceId} not found`, 'NOT_FOUND');
    if (!ws.config?.gitRepoUrl) return toolError('this workspace has no repository configured', 'NO_REPO');

    // `workspace:execute` was enforced at dispatch (DATA_TOOL_RULES). Shipping
    // also needs `workspace:write` on the same workspace — the child is only
    // ever given what the parent holds.
    const profile = getCapabilityProfile(state);
    if (!profile) {
      return toolError('workspace_task needs a capability profile granting workspace:execute on the workspace', 'FORBIDDEN');
    }
    const aliases = workspaceAliases({ workspaceId, repo: ws.config?.gitRepoUrl, branch: ws.config?.gitBranch });
    const configuredBase: string = (typeof ws.config?.gitBranch === 'string' && ws.config.gitBranch.trim()) || 'main';
    const requestedBase = base || configuredBase;
    if (ship) {
      const decision = decideWorkspace(profile, 'write', aliases);
      if (!decision.allowed) return toolError(decision.reason ?? 'workspace:write is required for ship:true', 'FORBIDDEN');
      // A PR into any branch other than the workspace's base needs a write
      // grant naming that base (`<o>/<r>@<base>`), not just the workspace.
      const baseDecision = decideShipBase(profile, { repo: ws.config?.gitRepoUrl, configuredBase }, requestedBase);
      if (!baseDecision.allowed) {
        persistDenial(
          context,
          'workspace_task',
          new CapabilityDeniedError({
            resource: 'workspace',
            action: 'write',
            address: baseDecision.address ?? requestedBase,
            profileName: profile.name ?? 'unnamed-profile',
            message: baseDecision.reason ?? 'Permission denied.',
          }),
        );
        return toolError(baseDecision.reason ?? `opening a pull request into '${requestedBase}' is not allowed`, 'FORBIDDEN');
      }
    }

    const parentDepth = Number(state?.data?.input?._invokeGraphDepth ?? state?._invokeGraphDepth ?? 0) || 0;
    if (parentDepth + 1 > MAX_INVOKE_DEPTH) return toolError('recursion limit exceeded', 'RECURSION');

    const publisher = context?.publisher as AnyObject | null;
    const redShape = buildRedShape(state, publisher);
    if (!redShape) return toolError('cannot start a child run from this context (missing run infrastructure)', 'UNAVAILABLE');

    const graphRegistry = getGraphRegistry(state);
    try {
      await graphRegistry.getConfig(WORKSPACE_TASK_GRAPH_ID, owner);
    } catch {
      return toolError(`the platform worker graph '${WORKSPACE_TASK_GRAPH_ID}' is not installed`, 'UNAVAILABLE');
    }

    const childRunId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const checkoutKey = `task-${childRunId.slice(-9)}`;
    const parentRunId = state.runId || state.data?.runId || context?.runId;
    const childIsModelDriven = context?.untrustedCaller === true || isModelDrivenState(state);
    const input: AnyObject = {
      workspaceId,
      brief,
      ship,
      base: requestedBase,
      neuronId,
      checkoutKey,
      repo: ws.config?.gitRepoUrl,
      baseBranch: ws.config?.gitBranch ?? null,
      workspaceName: ws.name ?? null,
      parentRunId,
      _invokeGraphDepth: parentDepth + 1,
      ...(childIsModelDriven ? { [MODEL_DRIVEN_STATE_KEY]: true } : {}),
      _trigger: { type: 'workspace_task', metadata: { parentRunId, workspaceId, ship } },
    };
    const callerUserId = typeof state.callerUserId === 'string' && state.callerUserId !== owner ? state.callerUserId : undefined;
    const secretsIdentity = state.data?.secretsIdentity;

    const runModule = await import('../../../functions/run');
    const { run, isStreamingResult } = runModule;
    try {
      const submitted = run(redShape as any, input, {
        userId: owner,
        ...(callerUserId ? { connectionIdentityUserId: callerUserId } : {}),
        ...(callerUserId && (secretsIdentity === 'owner' || secretsIdentity === 'caller') ? { secretsIdentity } : {}),
        graphId: WORKSPACE_TASK_GRAPH_ID,
        runId: childRunId,
        stream: false,
        source: { application: 'workspace_task' },
        capabilityProfileOverride: deriveWorkspaceTaskProfile(
          workspaceId,
          ship,
          ship && requestedBase !== configuredBase ? { repo: ws.config?.gitRepoUrl, base: requestedBase } : null,
        ),
      });
      Promise.resolve(submitted).then(
        (result: any) => {
          if (isStreamingResult && isStreamingResult(result)) {
            return result.completion.catch((err: unknown) => {
              console.warn(`[workspace_task] child run ${childRunId} failed:`, err instanceof Error ? err.message : err);
            });
          }
          return result;
        },
        (err: unknown) => {
          console.warn(`[workspace_task] child run ${childRunId} failed to start:`, err instanceof Error ? err.message : err);
        },
      );
    } catch (err: unknown) {
      return toolError(`workspace_task failed to start: ${err instanceof Error ? err.message : String(err)}`, 'FAILED');
    }
    return toolOk({ runId: childRunId, workspaceId, checkoutKey, ship, status: 'queued' });
  },
};

export default tool;
module.exports = tool;
