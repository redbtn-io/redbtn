/**
 * The worker-wide CLI slot queue — one semaphore, two CLI executors.
 *
 * # What this is
 *
 * `claudeCodeExecutor` and `agyCliExecutor` both spawn a real CLI child per
 * step, and both must serialise those children per worker replica: one Claude
 * CLI child is ~624 MB resident against a replica capped at 2304 MiB, and `agy`
 * is smaller but not free. Each executor owns its OWN queue instance — the two
 * CLIs cost different amounts of memory and are tuned by different env vars —
 * but the queue itself was the same forty lines twice, and the second copy had
 * already drifted: #463 taught the `claude-code` copy to report progress while
 * queued and left the `agy-cli` copy silent, so an `agy-cli` step that waited
 * out the 30-minute stale window still had its run interrupted before its CLI
 * ever started.
 *
 * So the mechanism lives here once and the two executors differ only in the
 * three things that actually differ: the name in the prose, how the limit is
 * read, and which error class a wait that ran out throws.
 *
 * # What it is NOT
 *
 * It is not cross-replica. This counts children on THIS process, and BullMQ
 * places runs on replicas without consulting it, so three runs can still land
 * on one replica while a sibling sits idle. The progress ticks below are what
 * keep that from being fatal (a queued run stays alive instead of being
 * reaped); making the placement itself slot-aware is a scheduler change, not a
 * semaphore change.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

/**
 * How often a queued step says it is still queued.
 *
 * The run-level watchdog interrupts a run whose `lastProgressAt` has not moved
 * for 30 minutes, and a step waiting for a slot touches nothing until its CLI
 * starts — so a run that waited longer than that was interrupted before it had
 * spawned anything at all (run_1789454327425_zvof94, 2026-09-15). Waiting for a
 * worker IS progress; it is just progress the model did not make.
 */
export const SLOT_WAIT_PROGRESS_INTERVAL_MS = 60 * 1000;

/**
 * Below this, a step did not really queue — it took a free slot and the clock
 * merely ticked — and saying so every time would bury the lines that matter.
 */
export const SLOT_ADMISSION_LOG_THRESHOLD_MS = 1000;

export interface CliSlotQueueOptions {
  /** `'claude-code'` / `'agy-cli'`. Used verbatim in the abort prose. */
  provider: string;
  /**
   * The limit, read at ACQUIRE time rather than at import time, so RedRun can
   * change it on a running replica without a code change.
   */
  maxConcurrent: () => number;
  /**
   * The error a wait that ran out throws. Provider-specific because the CODE
   * is what callers switch on (`claude_code_queue_timeout` / `agy_queue_timeout`)
   * and the message names the env var an operator would raise.
   */
  queueTimeoutError: (maxWaitMs: number, maxConcurrent: number) => Error;
}

export interface CliSlotQueue {
  /**
   * Wait for a slot, but never past `maxWaitMs`.
   *
   * An unbounded wait is not "patient", it is a queue with no failure mode:
   * with a limit of 1 one two-hour child parks every other step behind it
   * until the WORKER's own job race fails them while they are still queued —
   * and the executor would then acquire the slot and spawn a real CLI child,
   * spending subscription quota, for a run that is already terminal. Failing
   * fast with a distinct code is the honest answer: the step could not get a
   * worker, which is an operational fact worth seeing.
   *
   * `onWaiting` is called every `SLOT_WAIT_PROGRESS_INTERVAL_MS` with a reason
   * naming how many CLI children are ahead of this one (running, plus queued
   * before it), so the caller can keep the run's heartbeat alive on the channel
   * it already uses. It fires only while the step is actually queued: a step
   * that gets a slot straight away says nothing, and the ticks stop the moment
   * the step is admitted, aborted or timed out.
   */
  acquire(
    abortSignal: AbortSignal | undefined,
    maxWaitMs: number,
    onWaiting?: (reason: string) => void,
  ): Promise<void>;
  /** Give the slot back and admit the next queued step. */
  release(): void;
  /** Current occupancy. Test-only, and for the ops log line. */
  inUse(): number;
}

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** Build one worker-wide semaphore. One instance per executor, at module load. */
export function createCliSlotQueue(options: CliSlotQueueOptions): CliSlotQueue {
  const { provider, maxConcurrent, queueTimeoutError } = options;
  let activeChildren = 0;
  const waiters: Array<() => void> = [];

  return {
    inUse(): number {
      return activeChildren;
    },

    release(): void {
      activeChildren = Math.max(0, activeChildren - 1);
      const next = waiters.shift();
      if (next) next();
    },

    async acquire(
      abortSignal: AbortSignal | undefined,
      maxWaitMs: number,
      onWaiting?: (reason: string) => void,
    ): Promise<void> {
      if (abortSignal?.aborted) {
        throw abortError(`Run aborted before ${provider} slot acquired`);
      }
      if (activeChildren < maxConcurrent()) {
        activeChildren += 1;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | null = null;
        let progressTimer: NodeJS.Timeout | null = null;
        const stopProgress = () => {
          if (progressTimer) clearInterval(progressTimer);
          progressTimer = null;
        };
        const unqueue = () => {
          const idx = waiters.indexOf(admit);
          if (idx >= 0) waiters.splice(idx, 1);
          if (timer) clearTimeout(timer);
          stopProgress();
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          unqueue();
          reject(abortError(`Run aborted while queued for a ${provider} slot`));
        };
        function admit(): void {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          stopProgress();
          abortSignal?.removeEventListener('abort', onAbort);
          activeChildren += 1;
          resolve();
        }
        if (onWaiting) {
          progressTimer = setInterval(() => {
            const queuedAhead = Math.max(0, waiters.indexOf(admit));
            try {
              onWaiting(`waiting for a CLI slot (${activeChildren + queuedAhead} ahead)`);
            } catch {
              /* a heartbeat that cannot be reported must not break the queue */
            }
          }, SLOT_WAIT_PROGRESS_INTERVAL_MS);
          progressTimer.unref?.();
        }
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          unqueue();
          abortSignal?.removeEventListener('abort', onAbort);
          reject(queueTimeoutError(maxWaitMs, maxConcurrent()));
        }, maxWaitMs);
        timer.unref?.();
        waiters.push(admit);
        abortSignal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

/**
 * The `onWaiting` callback both executors pass, built once.
 *
 * `nodeProgress` is the channel every other step event already uses, and
 * publishing one refreshes the run's heartbeat in `RunPublisher.publish`; there
 * is no second channel here. Returns `undefined` when the run has no publisher
 * that can carry a tick, which is exactly when `acquire` should not bother
 * starting an interval.
 */
export function slotWaitReporter(args: {
  publisher: AnyObject | undefined;
  /** `runControlRegistry.get(runId)?.currentNodeId` — the node the tick belongs to. */
  currentNodeId: () => string | undefined;
  stepId: string;
  runId: string;
  /** `'ClaudeCode'` / `'AgyCli'`, for the warn line if the publish fails. */
  logPrefix: string;
}): ((reason: string) => void) | undefined {
  const { publisher, currentNodeId, stepId, runId, logPrefix } = args;
  if (!publisher?.nodeProgress) return undefined;
  return (reason: string) => {
    const nodeId = currentNodeId() || stepId;
    void Promise.resolve(
      publisher.nodeProgress(nodeId, reason, { data: { stepId, phase: 'queued' } }),
    ).catch((err: unknown) => {
      // A heartbeat that cannot be published must not fail the step; the
      // watchdog's own timeout remains the backstop.
      console.warn(`[${logPrefix}] queued-progress publish failed for run ${runId}:`, err);
    });
  };
}

/**
 * One line when a step was really queued, so the wait is visible in the worker
 * log next to the run it delayed. `queuedMs` also rides out on the step's
 * `_cli` result, which is where it survives the log rotation.
 */
export function logSlotAdmission(logPrefix: string, stepId: string, queuedMs: number): void {
  if (queuedMs <= SLOT_ADMISSION_LOG_THRESHOLD_MS) return;
  console.warn(`[${logPrefix}] step '${stepId}' admitted after ${queuedMs} ms waiting for a CLI slot`);
}
