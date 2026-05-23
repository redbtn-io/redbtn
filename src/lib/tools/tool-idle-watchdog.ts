export class ToolHangError extends Error {
  readonly name = 'ToolHangError';
  readonly code = 'TOOL_IDLE_TIMEOUT';
  readonly idleTimeoutMs: number;
  readonly toolName?: string;

  constructor(params: { idleTimeoutMs: number; toolName?: string }) {
    super(
      params.toolName
        ? `Tool "${params.toolName}" made no progress for ${params.idleTimeoutMs}ms`
        : `Tool made no progress for ${params.idleTimeoutMs}ms`,
    );
    this.idleTimeoutMs = params.idleTimeoutMs;
    this.toolName = params.toolName;
  }
}

export interface ToolIdleWatchdogHandle {
  /** Reset the idle timer after real tool progress, such as output bytes. */
  markProgress: () => void;
}

export interface ToolIdleWatchdogOptions {
  idleTimeoutMs: number;
  toolName?: string;
  abortController?: AbortController;
}

/**
 * Wrap a tool promise in an idle watchdog.
 *
 * This is intentionally NOT a total-runtime timeout. A long-running tool can
 * run indefinitely as long as it calls `markProgress()` before each idle
 * window expires. If no progress arrives, the watchdog aborts the supplied
 * controller and rejects with ToolHangError so normal step errorHandling can
 * catch the failure.
 */
export async function withToolIdleWatchdog<T>(
  operation: (watchdog: ToolIdleWatchdogHandle) => Promise<T>,
  options: ToolIdleWatchdogOptions,
): Promise<T> {
  const idleTimeoutMs = Math.max(0, options.idleTimeoutMs);
  if (idleTimeoutMs === 0) {
    return operation({ markProgress: () => {} });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let rejectTimeout: ((error: ToolHangError) => void) | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const armTimer = () => {
    clearTimer();
    if (settled) return;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new ToolHangError({
        idleTimeoutMs,
        toolName: options.toolName,
      });
      if (options.abortController && !options.abortController.signal.aborted) {
        options.abortController.abort(error);
      }
      rejectTimeout?.(error);
    }, idleTimeoutMs);
    timer.unref?.();
  };

  const watchdog: ToolIdleWatchdogHandle = {
    markProgress: () => {
      if (!settled) armTimer();
    },
  };

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
    armTimer();
  });

  try {
    const operationPromise = Promise.resolve().then(() => operation(watchdog));
    const result = await Promise.race([operationPromise, timeoutPromise]);
    settled = true;
    clearTimer();
    return result;
  } catch (error) {
    settled = true;
    clearTimer();
    throw error;
  }
}
