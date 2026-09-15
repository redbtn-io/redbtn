/**
 * Workspace binding hygiene.
 *
 * A "workspace binding" is the set of `state.data` fields that tie a run to a
 * checked-out workspace container — `workspaceId`, `workspaceMode`,
 * `checkoutKey`, `checkoutId`, `ws`, `workspaceCheckout`, plus the
 * `environmentId`/`workingDir` a checkout resolves to. Anything that reads
 * those fields will happily bring a container up: `acquireWorkspaceForStep`
 * (neuronExecutor) treats a bare `data.workspaceId` as "check this workspace
 * out", which is exactly what makes a stale binding dangerous.
 *
 * Only `data` matters here. `state.parameters` is rebuilt per node by
 * `universalNode` from that node's OWN config and is not a LangGraph channel,
 * so it cannot cross a node boundary — that is the "unless its own config asks
 * for one" escape hatch, and stripping it would close the wrong door.
 *
 * TWO RULES, DELIBERATELY DIFFERENT:
 *
 *  1. THE EXECUTOR ONLY STRIPS WHAT IT WROTE.
 *     `acquireWorkspaceForStep` promotes `environmentId`/`checkoutId`/`ws`/
 *     `workingDir` (and, when it came from `parameters`, `workspaceId`) onto
 *     state so the step's tools can address the container. When the step's
 *     `finally` releases that checkout, those fields point at a container that
 *     has just been stopped and snapshotted, so the step must put the binding
 *     back exactly the way it found it — see `snapshotWorkspaceBinding` /
 *     `restoreWorkspaceBinding`. It must NOT strip a `workspaceId` a node's own
 *     transform step wrote: that field is the node's configuration, not the
 *     executor's bookkeeping, and a later step in the same node legitimately
 *     re-acquires from it.
 *
 *  2. THE ERROR-HANDLER TRANSITION STRIPS EVERYTHING — `stripWorkspaceBinding`.
 *     A node that fails mid-run leaves whatever it configured on `data`, and
 *     the compiler then routes to `error_handler` (see `compiler.ts`, every
 *     edge checks `state.data.nextGraph === 'error_handler'`). The error
 *     handler is a reporting node; it has no business inside a working copy.
 *     2026-09-15 (run_1789454028274_vweebx): `redboard-red-executor-workspace`
 *     failed at a tool step, its neuron step released its checkout correctly,
 *     and the error handler's own neuron step then read the failed node's
 *     leftover `data.workspaceId`/`workspaceMode`/`checkoutKey` and spawned a
 *     SECOND checkout (`ws_is8EX3zJRoEh_chk_zdj49o23Sc`) — which then died on a
 *     hub outage and leaked its container until it was removed by hand.
 */

/**
 * Every `state.data` key that can bind a run to a workspace. `environmentId`
 * and `workingDir` are in the list but are conditional — see
 * `stripWorkspaceBinding`.
 */
export const WORKSPACE_BINDING_DATA_KEYS = [
  'workspaceId',
  'workspaceMode',
  'checkoutKey',
  'checkoutId',
  'ws',
  'workspaceCheckout',
  'environmentId',
  'workingDir',
] as const;

/** `state.data` keys `acquireWorkspaceForStep` writes when it checks a workspace out. */
const ACQUISITION_DATA_KEYS = [
  'workspaceId',
  'environmentId',
  'checkoutId',
  'ws',
  'workingDir',
] as const;

/** `state.parameters` keys `acquireWorkspaceForStep` writes when it checks a workspace out. */
const ACQUISITION_PARAMETER_KEYS = ['environmentId', 'workingDir'] as const;

/** A binding is "present" when something names a workspace — not merely an environment. */
function hasWorkspaceBinding(data: Record<string, any>): boolean {
  return Boolean(
    data.workspaceId ||
      data.workspaceMode ||
      data.checkoutKey ||
      data.checkoutId ||
      data.ws ||
      data.workspaceCheckout,
  );
}

/**
 * Is `data.environmentId` one a workspace checkout produced, or one the run
 * pinned for its own reasons (a desktop agent, an SSH node, a dev container)?
 *
 * Only the first may be stripped. Dropping a caller-pinned environment would
 * take the error handler's own tools offline, so we strip only on positive
 * evidence: the id matches the embedded checkout, or a `checkoutId` sits beside
 * it — `data.checkoutId` is written by nothing but `acquireWorkspaceForStep`
 * and `resolveWorkspaceEnvironment`, both of which set it alongside the
 * environment they resolved.
 */
function isWorkspaceDerivedEnvironment(data: Record<string, any>): boolean {
  const env = data.environmentId;
  if (!env) return false;
  if (data.ws?.environmentId === env) return true;
  if (data.workspaceCheckout?.environmentId === env) return true;
  return Boolean(data.checkoutId);
}

/**
 * Remove the whole workspace binding from `state.data`, in place, and return it
 * as a partial `data` patch so the caller can fold the clear into the node's
 * LangGraph state update (the `data` reducer deep-merges, so an explicit
 * `undefined` is what actually clears a key downstream).
 *
 * No-op — returns `{}` — when nothing on the state names a workspace. That
 * guard is what keeps a run whose `environmentId` was pinned by hand from
 * losing it on the way into the error handler.
 */
export function stripWorkspaceBinding(state: any): Record<string, undefined> {
  const data: Record<string, any> | undefined =
    state && typeof state === 'object' ? state.data : undefined;
  if (!data || typeof data !== 'object') return {};
  if (!hasWorkspaceBinding(data)) return {};

  const envIsOurs = isWorkspaceDerivedEnvironment(data);
  const cleared: Record<string, undefined> = {};

  for (const key of WORKSPACE_BINDING_DATA_KEYS) {
    // `workingDir` is only ever pinned to the container mount alongside an
    // environment we resolved; leave a hand-set cwd alone the same way.
    if ((key === 'environmentId' || key === 'workingDir') && !envIsOurs) continue;
    if (!(key in data)) continue;
    delete data[key];
    cleared[key] = undefined;
  }

  return cleared;
}

/** What the workspace binding looked like before a step acquired a checkout. */
export interface WorkspaceBindingSnapshot {
  /** Present-and-value pairs for `state.data`, keyed by field. */
  data: Record<string, { present: boolean; value: unknown }>;
  /** Present-and-value pairs for `state.parameters`, keyed by field. */
  parameters: Record<string, { present: boolean; value: unknown }>;
}

/**
 * Record the acquisition-owned fields BEFORE `acquireWorkspaceForStep` runs, so
 * the step can undo exactly its own writes when it releases the checkout.
 */
export function snapshotWorkspaceBinding(state: any): WorkspaceBindingSnapshot {
  const snapshot: WorkspaceBindingSnapshot = { data: {}, parameters: {} };
  const data = state && typeof state === 'object' ? state.data : undefined;
  const parameters = state && typeof state === 'object' ? state.parameters : undefined;

  for (const key of ACQUISITION_DATA_KEYS) {
    const present = Boolean(data && typeof data === 'object' && key in data);
    snapshot.data[key] = { present, value: present ? data[key] : undefined };
  }
  for (const key of ACQUISITION_PARAMETER_KEYS) {
    const present = Boolean(parameters && typeof parameters === 'object' && key in parameters);
    snapshot.parameters[key] = { present, value: present ? parameters[key] : undefined };
  }

  return snapshot;
}

/**
 * Put the acquisition-owned fields back the way `snapshotWorkspaceBinding` found
 * them. Call this after releasing a checkout THIS step owns — never when an
 * outer owner holds it, since the binding is then still live.
 */
export function restoreWorkspaceBinding(state: any, snapshot: WorkspaceBindingSnapshot): void {
  if (!state || typeof state !== 'object' || !snapshot) return;

  const data = state.data;
  if (data && typeof data === 'object') {
    for (const [key, before] of Object.entries(snapshot.data)) {
      if (before.present) data[key] = before.value;
      else delete data[key];
    }
  }

  const parameters = state.parameters;
  if (parameters && typeof parameters === 'object') {
    for (const [key, before] of Object.entries(snapshot.parameters)) {
      if (before.present) parameters[key] = before.value;
      else delete parameters[key];
    }
  }
}
