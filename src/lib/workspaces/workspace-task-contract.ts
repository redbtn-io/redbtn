/**
 * Shared constants + the derived child profile for `workspace_task`.
 *
 * Kept out of the tool modules: those end in `module.exports = tool`, which
 * drops named exports in the compiled CommonJS build.
 */
import type { CapabilityProfile } from '../permissions/types';
import { repoBaseAliases } from '../permissions/workspace-grants';
import { getRunPublisher } from '../run/contextLookup';

type AnyObject = Record<string, any>;

/** The platform worker graph a workspace_task child runs (ops/workspace-task/). */
export const WORKSPACE_TASK_GRAPH_ID = 'workspace-task';

/** Default worker neuron (a claude-code CLI neuron — Claude Sonnet 5). */
export const WORKSPACE_TASK_DEFAULT_NEURON = 'isTFRza5QAZe';

/**
 * The child run's capability profile: exactly the workspace grants the parent
 * was checked against, never broader. `read` lets the worker look at its own
 * workspace; `execute` lets its producer check the workspace out (which
 * derives exec on that checkout's environment only); `write` (ship only) lets
 * it push its branch and open a PR into the workspace's base branch. When the
 * parent was allowed to ship into ANOTHER base (it holds write on
 * `<o>/<r>@<base>`, see decideShipBase), `shipBase` adds exactly that grant —
 * and no other branch. No `control` (merge), no state, knowledge or exec
 * grants of its own.
 */
export function deriveWorkspaceTaskProfile(
  workspaceId: string,
  ship: boolean,
  shipBase?: { repo: unknown; base: string } | null,
): CapabilityProfile {
  const capabilities: CapabilityProfile['capabilities'] = [
    { resource: 'workspace', actions: ship ? ['read', 'execute', 'write'] : ['read', 'execute'], selector: workspaceId },
  ];
  const baseSelector = ship && shipBase ? repoBaseAliases(shipBase.repo, shipBase.base)[1] : undefined;
  if (baseSelector) capabilities.push({ resource: 'workspace', actions: ['write'], selector: baseSelector });
  return {
    name: `workspace-task:${workspaceId}`,
    description:
      'Derived by workspace_task: this worker may check out and work in exactly one workspace' +
      (ship ? `, and push its branch / open a pull request into ${baseSelector ? `'${shipBase!.base}'` : 'its base branch'}` : '') +
      '. No merge, no state or knowledge access, no exec outside its own checkout.',
    capabilities,
  };
}

/**
 * A workspace_task run's Redis state, read through the calling run's publisher
 * (the same connection the engine uses), or null. A context without one (the
 * neuron tool-use loop and the CLI run bridge pass `publisher: null`) falls
 * back to the run's own publisher from the run-control registry.
 */
export async function readWorkspaceTaskState(
  context: { publisher?: unknown; state?: unknown } | undefined,
  runId: string,
): Promise<AnyObject | null> {
  const publisher = (context?.publisher ?? getRunPublisher(context?.state)) as any;
  const redis = publisher?.redis;
  if (!runId || !redis || typeof redis.get !== 'function') return null;
  try {
    const raw = await redis.get(`run:${runId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
