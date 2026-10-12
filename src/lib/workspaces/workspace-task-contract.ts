/**
 * Shared constants + the derived child profile for `workspace_task`.
 *
 * Kept out of the tool modules: those end in `module.exports = tool`, which
 * drops named exports in the compiled CommonJS build.
 */
import type { CapabilityProfile } from '../permissions/types';

type AnyObject = Record<string, any>;

/** The platform worker graph a workspace_task child runs (ops/workspace-task/). */
export const WORKSPACE_TASK_GRAPH_ID = 'workspace-task';

/** Default worker neuron (a claude-code CLI neuron). */
export const WORKSPACE_TASK_DEFAULT_NEURON = 'sonnet-5';

/**
 * The child run's capability profile: exactly the workspace grants the parent
 * was checked against, never broader. `read` lets the worker look at its own
 * workspace; `execute` lets its producer check the workspace out (which
 * derives exec on that checkout's environment only); `write` (ship only) lets
 * it push its branch and open a PR. No `control` (merge), no state, knowledge
 * or exec grants of its own.
 */
export function deriveWorkspaceTaskProfile(workspaceId: string, ship: boolean): CapabilityProfile {
  return {
    name: `workspace-task:${workspaceId}`,
    description:
      'Derived by workspace_task: this worker may check out and work in exactly one workspace' +
      (ship ? ', and push its branch / open a pull request from it' : '') +
      '. No merge, no state or knowledge access, no exec outside its own checkout.',
    capabilities: [
      { resource: 'workspace', actions: ship ? ['read', 'execute', 'write'] : ['read', 'execute'], selector: workspaceId },
    ],
  };
}

/**
 * A workspace_task run's Redis state, read through the parent run publisher's
 * client (the same connection the engine uses), or null.
 */
export async function readWorkspaceTaskState(context: { publisher?: unknown } | undefined, runId: string): Promise<AnyObject | null> {
  const redis = (context?.publisher as any)?.redis;
  if (!runId || !redis || typeof redis.get !== 'function') return null;
  try {
    const raw = await redis.get(`run:${runId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
