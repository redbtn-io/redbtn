/**
 * Wait — Native Utility Tool
 *
 * Sleep for a specified number of milliseconds. Respects the run-level
 * AbortSignal so an in-flight `wait` yields immediately on external
 * interrupt rather than blocking the worker.
 *
 * Spec: TOOL-HANDOFF.md §4.15
 *   - inputs: ms (required, integer 1-300000)
 *   - output: { ok: true, waited: ms }
 *
 * Implementation:
 *   - Mirrors the abort-aware sleep used by the `delay` step in
 *     `redbtn/src/lib/nodes/universal/stepExecutor.ts`. The signal is
 *     resolved via `RunControlRegistry.get(runId)?.controller.signal` —
 *     surviving any state-serialization round-trip — with the in-context
 *     `abortSignal` and `state._abortController` as fallbacks for direct or
 *     test callers.
 *   - Range guard: 1 ≤ ms ≤ 300000 (5 minutes). Anything outside is a
 *     VALIDATION error. Non-integer numeric values are rejected — agents
 *     should be passing whole milliseconds.
 *   - On abort the handler resolves with isError:true and the partial
 *     elapsed wait so the caller knows whether the sleep happened.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface WaitArgs {
  ms: number;
}

const MIN_MS = 1;
const MAX_MS = 300_000;

function validationError(message: string): NativeMcpResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message, code: 'VALIDATION' }),
      },
    ],
    isError: true,
  };
}

/**
 * Resolve the run-level AbortSignal in the same order as the `delay` step:
 *   1. RunControlRegistry by state.runId / context.runId  (canonical, survives
 *      checkpoint serialization)
 *   2. context.abortSignal                                (passed by direct
 *                                                          callers / tests)
 *   3. state._abortController?.signal                     (legacy fallback)
 *
 * Returns `undefined` when nothing is registered — the wait still works,
 * it just isn't externally cancellable.
 */
function resolveAbortSignal(context: NativeToolContext): AbortSignal | undefined {
  // Try the run registry first — canonical source for run-scoped aborts.
  // The require is wrapped because the registry isn't always loaded (e.g.
  // unit tests can poke this tool directly without booting a worker).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../run/RunControlRegistry');
    const registry = mod?.runControlRegistry;
    if (registry && typeof registry.get === 'function') {
      const stateRunId =
        (context.state as AnyObject | null | undefined)?.runId ||
        (context.state as AnyObject | null | undefined)?.data?.runId;
      const runId = context.runId || stateRunId;
      const ctx = registry.get(runId);
      const signal = ctx?.controller?.signal as AbortSignal | undefined;
      if (signal) return signal;
    }
  } catch {
    // Registry not available — fall through to context / state fallbacks.
  }
  if (context.abortSignal) return context.abortSignal;
  const stashed =
    (context.state as AnyObject | null | undefined)?._abortController?.signal;
  return stashed as AbortSignal | undefined;
}

const waitTool: NativeToolDefinition = {
  description:
    'Sleep for a specified number of milliseconds (1 to 300000). Use to back off between polling attempts, throttle outbound requests, or insert deliberate timing into a graph. Respects run cancellation — an interrupted wait returns immediately with isError:true.',
  server: 'utility',
  inputSchema: {
    type: 'object',
    properties: {
      ms: {
        type: 'integer',
        description:
          'How many milliseconds to wait. Must be in the range 1..300000 (5 minutes max).',
        minimum: MIN_MS,
        maximum: MAX_MS,
      },
    },
    required: ['ms'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<WaitArgs>;

    if (typeof args.ms !== 'number' || !Number.isFinite(args.ms)) {
      return validationError('ms is required and must be a finite number');
    }
    if (!Number.isInteger(args.ms)) {
      return validationError('ms must be an integer (whole milliseconds)');
    }
    if (args.ms < MIN_MS || args.ms > MAX_MS) {
      return validationError(
        `ms must be between ${MIN_MS} and ${MAX_MS} (got ${args.ms})`,
      );
    }

    const ms = args.ms;
    const signal = resolveAbortSignal(context);
    const startedAt = Date.now();

    try {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Wait aborted'));
          return;
        }
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onAbort = () => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          reject(new Error('Wait aborted'));
        };
        timer = setTimeout(() => {
          timer = null;
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, waited: ms }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - startedAt;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: message,
              code: 'ABORTED',
              waited: elapsed,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default waitTool;
module.exports = waitTool;
