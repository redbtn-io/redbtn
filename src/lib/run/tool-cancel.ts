/**
 * Tool cancellation helpers — bounded grace + safe process-group kill.
 *
 * Steering / interrupt flow (see RunControlRegistry.cancel):
 *   1. `cancel()` fires tool `onCancel` hooks FIRST (tools kill remote work /
 *      request child teardown), then aborts the run controller.
 *   2. In-flight tool promises receive the abort via their `abortSignal`.
 *   3. A well-behaved tool settles quickly → its output is captured and the
 *      run finalizes cleanly so the steered turn can acquire the run lock.
 *   4. A hung tool that ignores abort must NOT block the interrupt ACK or
 *      hold the run lock indefinitely → `awaitWithCancelGrace` bounds the
 *      post-abort wait and then rejects with a TOOL_INTERRUPTED error so the
 *      run finalizes and releases the lock.
 *
 * Process-group kill (`killProcessGroupWithEscalation`) is the hard backstop
 * for locally-spawned children: SIGTERM now, SIGKILL after a short grace.
 * Remote work (ssh_shell / run_command over SSH) is killed via the tool's own
 * side-channel in its onCancel hook — a local `kill(-pgid)` cannot reach a
 * remote pid. Tools that spawn local children SHOULD route their kill through
 * this module so every kill gets the same guards.
 *
 * Guards (all load-bearing — see opencodeExecutor.ts for the incident history):
 *   - only signal when WE created the group (`detached: true` ⇒ child pid is
 *     the group leader, `pgid === pid` at the spawn site)
 *   - never signal `pgid <= 1` (would hit the whole machine / init)
 *   - never signal our own group (`pgid === process.pid`)
 *   - `ESRCH` (already gone) is success, not an error
 *   - `EPERM` is logged and treated as failure — the caller must still
 *     finalize the run / release the lock rather than hang
 *   - negative-pid kill is POSIX-only — no-op on win32
 *
 * @module lib/run/tool-cancel
 */

/** Post-abort grace for an in-flight tool to settle cleanly (steer path). */
export const TOOL_CANCEL_GRACE_MS_DEFAULT = Math.max(
  0,
  Number(process.env.TOOL_CANCEL_GRACE_MS ?? 5000) || 5000,
);

/** Delay between SIGTERM and the SIGKILL follow-up. */
export const TOOL_SIGKILL_GRACE_MS_DEFAULT = Math.max(
  0,
  Number(process.env.TOOL_SIGKILL_GRACE_MS ?? 2000) || 2000,
);

export const TOOL_INTERRUPTED_CODE = 'TOOL_INTERRUPTED';

export class ToolInterruptedError extends Error {
  readonly code = TOOL_INTERRUPTED_CODE;
  readonly toolName?: string;
  constructor(toolName?: string, reason?: string) {
    super(
      toolName
        ? `[tool-interrupted] Tool "${toolName}" did not settle after interrupt${reason ? `: ${reason}` : ''}`
        : `[tool-interrupted] Tool did not settle after interrupt${reason ? `: ${reason}` : ''}`,
    );
    this.name = 'ToolInterruptedError';
    this.toolName = toolName;
  }
}

export function isToolInterruptedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === TOOL_INTERRUPTED_CODE) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('[tool-interrupted]');
}

function validGroupTarget(pgid: number): boolean {
  if (!Number.isFinite(pgid) || pgid <= 1) return false;
  if (pgid === process.pid) return false;
  return true;
}

/**
 * Send one signal to a process group. Returns true when the signal was
 * delivered OR the group is already gone (ESRCH). Returns false when the
 * target is invalid, the platform cannot do group kills, or delivery failed.
 */
export function signalProcessGroup(
  pgid: number,
  signal: NodeJS.Signals,
  opts?: { logPrefix?: string },
): boolean {
  const prefix = opts?.logPrefix ?? '[tool-cancel]';
  if (!validGroupTarget(pgid)) return false;
  if (process.platform === 'win32') {
    console.warn(`${prefix} skipping group kill of ${pgid}: process groups unsupported on win32`);
    return false;
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return true; // already gone — success
    console.warn(`${prefix} group kill ${signal} on pgid ${pgid} failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * SIGTERM a process group now, follow up with SIGKILL after `sigkillGraceMs`
 * unless `cancel()` is called first (tool exited cleanly — call cancel to
 * avoid SIGKILLing a recycled pgid).
 *
 * Only call with a pgid this process created as a group leader
 * (`spawn(..., { detached: true })` ⇒ `pgid === child.pid`).
 */
export function killProcessGroupWithEscalation(
  pgid: number,
  opts?: { sigkillGraceMs?: number; logPrefix?: string },
): { cancel: () => void; termDelivered: boolean } {
  const sigkillGraceMs = Math.max(0, opts?.sigkillGraceMs ?? TOOL_SIGKILL_GRACE_MS_DEFAULT);
  const prefix = opts?.logPrefix ?? '[tool-cancel]';
  const termDelivered = signalProcessGroup(pgid, 'SIGTERM', { logPrefix: prefix });
  if (!termDelivered) return { cancel: () => {}, termDelivered };
  const timer = setTimeout(() => {
    // Skip the SIGKILL when the group is already gone (common: child exited
    // cleanly but the caller never called cancel()). Probing first also keeps
    // the "ignored SIGTERM" warn honest — ESRCH delivery counts as success in
    // signalProcessGroup, so without this every clean exit would log a scare.
    try {
      process.kill(-pgid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') return;
      // EPERM means the group exists but isn't ours to signal — fall through
      // to the SIGKILL attempt so the outcome is logged, not silent.
    }
    const ok = signalProcessGroup(pgid, 'SIGKILL', { logPrefix: prefix });
    if (ok) console.warn(`${prefix} pgid ${pgid} ignored SIGTERM — sent SIGKILL`);
  }, sigkillGraceMs);
  // Deliberately NOT unref'd: this timer is orphan prevention — a drained
  // event loop must still deliver the SIGKILL (detached children survive
  // process exit, so an unref'd escalation can leak a live process group).
  return {
    termDelivered,
    cancel: () => clearTimeout(timer),
  };
}

/**
 * Await a tool promise with a bounded post-abort grace.
 *
 *   - No signal / signal never aborts → plain await (zero behaviour change
 *     for healthy runs).
 *   - Signal aborts (or already aborted) → wait up to `graceMs` for the tool
 *     to settle cooperatively. Settles in time ⇒ its value/rejection is
 *     returned as-is (clean handoff — partial output preserved). Still
 *     hanging after the grace ⇒ reject with ToolInterruptedError so the run
 *     finalizes and frees the run lock instead of wedging behind a dead tool.
 *
 * Never swallows the tool's own rejection when it settles in time.
 */
export async function awaitWithCancelGrace<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined,
  opts?: { graceMs?: number; toolName?: string; reason?: string },
): Promise<T> {
  if (!signal) return promise;
  const graceMs = Math.max(0, opts?.graceMs ?? TOOL_CANCEL_GRACE_MS_DEFAULT);
  if (!signal.aborted) {
    // Fast path: settle normally unless an abort lands mid-flight.
    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        // NOT unref'd: this timer settles the outer race — unref would let a
        // drained event loop exit without ever rejecting (hung tool wedges
        // the run again, the exact failure this helper exists to prevent).
        const timer = setTimeout(() => {
          reject(new ToolInterruptedError(opts?.toolName, opts?.reason ?? signal.reason?.toString()));
        }, graceMs);
        // Give the tool its grace: if it settles first, the outer race
        // below resolves with the tool's own outcome and this timer is
        // cleared via the finally-equivalent on the tool promise.
        void Promise.resolve(promise).then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
  // Already aborted on entry — same grace, no listener needed.
  // NOT unref'd (see above): the rejection is load-bearing.
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new ToolInterruptedError(opts?.toolName, opts?.reason ?? signal.reason?.toString()));
    }, graceMs);
    void Promise.resolve(promise).then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  });
  return Promise.race([promise, timeout]);
}
