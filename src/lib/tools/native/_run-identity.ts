/**
 * Run identity — which user a native tool ACTS AS.
 *
 * Filename is prefixed with `_` — see `_task-helpers.ts` for the convention:
 * this module is a helper, not a registrable native tool. It deliberately has
 * NO imports at all (not even a type import from `../native-registry`), for
 * two reasons:
 *
 *   1. **No cycle, structurally.** Every native tool is loaded by
 *      `native-registry`, so anything a tool imports is reachable from the
 *      registry. The obvious home for this — `workspace-common.ts` — reaches
 *      `../../workspaces/WorkspaceLifecycle`, which `require`s `bullmq` at
 *      module scope and pulls in `../permissions/persist-denial`, which in turn
 *      names `../tools/native-registry`. That last hop is `import type` and so
 *      erases today, but importing the workspace stack into ten leaf fs/exec
 *      tools would make a one-line identity rule depend on a BullMQ Queue
 *      being constructible. Free functions over four string fields should not.
 *   2. **Hermetic tests.** `tests/security/env-tools-run-as-caller.test.ts`
 *      imports the fs/exec tools directly. With this module they need no
 *      Redis, no Mongo and no queue.
 *
 * `workspace-common.ts` keeps its `resolveRunUserId` export and delegates here,
 * so there is exactly ONE definition of the precedence in the engine.
 */

/**
 * The minimum shape of a `NativeToolContext` these resolvers read. Declared
 * structurally rather than imported so this module stays dependency-free;
 * `NativeToolContext` satisfies it.
 */
export interface RunIdentityContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state?: Record<string, any> | null;
}

/**
 * The identity a tool ACTS AS.
 *
 * Run-as-caller delegation (docs/RUN-AS-CALLER-DELEGATION-SPEC.md): an
 * automation declared `executionIdentity:'caller'` + `callerInvokable` is
 * triggered by somebody who is not its owner, the hub puts that VERIFIED
 * caller on the run, and `buildInitialState` mirrors it onto state as
 * `callerUserId` (top level and `data.callerUserId`). The spec's rule is that
 * CONNECTIONS, ENVIRONMENTS and SECRETS resolve as the caller while LLM
 * access, tier gating and metering stay on the owner.
 *
 * Use this for anything the run reaches for on the caller's behalf — an
 * environment, an SSH key, a managed workspace, a GitHub installation — and
 * `resolveRunOwnerUserId` for anything that spends or records against an
 * account.
 *
 * Undelegated runs have no `callerUserId` and fall through to the owner chain,
 * so nothing about a normal run changes.
 */
export function resolveRunUserId(context: RunIdentityContext | null | undefined): string | null {
  const s = context?.state;
  const caller = s?.callerUserId || s?.data?.callerUserId;
  if (typeof caller === 'string' && caller) return caller;
  return resolveRunOwnerUserId(context);
}

/**
 * The run OWNER — the automation's owner on a delegated run, and the same
 * person as the caller on every other one.
 *
 * Deliberately NOT caller-aware: this is the identity the spec keeps every
 * billing-shaped decision on (tier gating, metering, redToken ledger).
 */
export function resolveRunOwnerUserId(context: RunIdentityContext | null | undefined): string | null {
  const s = context?.state;
  const id = s?.data?.userId || s?.userId || s?.data?.options?.userId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * `resolveRunUserId` as a plain string, for the tools whose existing "no
 * userId" guard tests `if (!userId)` on a `string`. Same precedence; a missing
 * identity becomes `''` instead of `null`, so each call site keeps the error
 * message and error shape it already had.
 */
export function resolveRunUserIdOrEmpty(context: RunIdentityContext | null | undefined): string {
  return resolveRunUserId(context) || '';
}
