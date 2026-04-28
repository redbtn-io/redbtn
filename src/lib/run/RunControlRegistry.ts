/**
 * RunControlRegistry — per-process registry of in-flight run control contexts.
 *
 * # Why this exists
 *
 * Earlier interrupt plumbing (PR #1) stashed an `AbortController` on the
 * LangGraph `state._abortController` field and relied on `universalNode` /
 * step executors reading `state._abortController?.signal?.aborted` to bail
 * out cooperatively.
 *
 * That worked for non-checkpointed runs, but `MongoCheckpointer` round-trips
 * the state through JSON between every node — and `_abortController` is in
 * `NON_SERIALIZABLE_STATE_KEYS` (run.ts), so it gets stripped on every
 * checkpoint. After the first checkpoint, every abort check inside the graph
 * read `undefined?.signal?.aborted === undefined` (falsy) and was a no-op.
 *
 * The registry sidesteps state entirely. The interrupt subscriber in
 * `run.ts` registers a `RunControlContext` for each in-flight run on a
 * per-process singleton; node-level code (universalNode, step executors,
 * neuronExecutor, toolExecutor) reads the AbortSignal from the registry
 * keyed by `state.runId`. Because the registry lives in a plain JS Map
 * inside the worker process, it survives any state serialization round-trip.
 *
 * # Lifecycle
 *
 * 1. `run()` calls `runControlRegistry.register(runId, workerId)` BEFORE
 *    invoking the compiled graph.
 * 2. Step executors call `runControlRegistry.get(runId)?.controller?.signal`
 *    instead of reading from state.
 * 3. The interrupt subscriber (`subscribeForInterrupt` in run.ts) calls
 *    `runControlRegistry.cancel(runId, reason)` to trip the controller and
 *    cancel any in-flight neuron calls.
 * 4. `run()` calls `runControlRegistry.unregister(runId)` in a `finally`
 *    after the run completes (success / error / abort).
 *
 * # Cancellation semantics
 *
 * `cancel()` performs three actions in order:
 *   - Marks the controller signal as aborted (graph code's between-step and
 *     mid-stream abort checks fire).
 *   - Calls `.cancel()` on every registered NeuronCall so any in-flight LLM
 *     stream / invoke gets a direct AbortSignal trigger AND an optional
 *     force-close fallback after a short grace period.
 *   - Returns an ACK payload describing what was cancelled (for the
 *     handshake protocol — see webapp/src/app/api/v1/runs/[runId]/interrupt).
 *
 * # ACK contract
 *
 * `cancel()` returns synchronously with the diagnostic data the interrupt
 * endpoint forwards over `RunKeys.interruptAck(runId)`. The handshake code
 * is in `subscribeForInterrupt` (run.ts) — that function publishes the ACK
 * after invoking this registry.
 *
 * @module lib/run/RunControlRegistry
 */

/**
 * A single in-flight LLM call — registered by `NeuronRegistry.callNeuron()`
 * and unregistered when the call completes (or is cancelled).
 *
 * `cancel()` is what gives us cooperative + force-close cancellation. The
 * cooperative path simply aborts the controller (LangChain forwards this to
 * the underlying transport when it's plumbed properly). The force-close
 * path is a setTimeout that, after a short grace period, calls `.abort()`
 * on the underlying client / response if we have a handle on it. This
 * covers cases where LangChain's signal forwarding is incomplete (it varies
 * by provider and version).
 */
export class NeuronCall {
  readonly controller: AbortController;
  readonly startedAt: Date;
  /**
   * Optional handle on the underlying client / response. Populated by
   * `NeuronRegistry.callNeuron()` when it can introspect the LangChain
   * model's transport (for force-close fallback). Best-effort — many
   * providers don't expose a stable handle, in which case force-close
   * is a no-op and we rely on cooperative abort only.
   */
  underlyingClient?: { abort?: () => void } | null;
  private cancelled = false;

  constructor(public readonly neuronId: string) {
    this.controller = new AbortController();
    this.startedAt = new Date();
  }

  /**
   * Trigger cancellation of this call.
   *
   * Cooperative phase: aborts the controller. LangChain (when it forwards
   * the signal correctly) will pass this through to the transport and the
   * stream will reject. The mid-stream abort check in `neuronExecutor`
   * also picks this up between chunks.
   *
   * Force-close phase: after `gracePeriodMs` (default 1s), if we have an
   * `underlyingClient.abort()` handle, call it. This catches the case
   * where LangChain's signal forwarding is incomplete and the transport
   * keeps holding the socket open even after the abort fires.
   */
  cancel(opts?: { gracePeriodMs?: number; reason?: string }): void {
    if (this.cancelled) return;
    this.cancelled = true;
    try {
      this.controller.abort(opts?.reason ?? 'cancelled');
    } catch {
      try { this.controller.abort(); } catch { /* ignore */ }
    }
    const grace = opts?.gracePeriodMs ?? 1000;
    if (this.underlyingClient?.abort) {
      setTimeout(() => {
        try { this.underlyingClient?.abort?.(); } catch { /* ignore */ }
      }, grace).unref?.();
    }
  }
}

/**
 * Per-run control context — one per in-flight run on this worker process.
 *
 * Created by `register()` on run start, looked up by `get(runId)` during
 * graph execution, and torn down by `unregister(runId)` on run completion.
 */
export interface RunControlContext {
  runId: string;
  controller: AbortController;
  /**
   * Set of in-flight LLM calls owned by this run. NeuronRegistry.callNeuron
   * adds to this on call start and removes on completion. The interrupt
   * subscriber's `cancel()` walks this set and aborts each one.
   */
  neuronCalls: Set<NeuronCall>;
  /**
   * Last-known graph location — populated by universalNode. Used in the
   * ACK payload so the interrupt endpoint can report what was running.
   */
  currentNodeId?: string;
  currentStep?: { type: string; index: number };
  startedAt: Date;
  workerId: string;
}

/**
 * ACK payload returned by `cancel()`. Mirrored over the
 * `RunKeys.interruptAck(runId)` Redis channel by the interrupt subscriber.
 */
export interface CancelAck {
  ack: true;
  runId: string;
  workerId: string;
  currentNodeId?: string;
  currentStep?: { type: string; index: number };
  neuronCallsCancelled: number;
  reason?: string;
}

export interface CancelNoAck {
  ack: false;
  runId: string;
  reason?: string;
}

export type CancelResult = CancelAck | CancelNoAck;

/**
 * Process-singleton registry of in-flight run control contexts. There is
 * exactly one instance per worker process (see export at bottom).
 */
export class RunControlRegistry {
  private contexts = new Map<string, RunControlContext>();

  /**
   * Create + register a new control context for a run. Idempotent — if a
   * context already exists for `runId` it's returned as-is (the engine
   * handles run-id collisions at a higher layer).
   */
  register(runId: string, workerId: string): RunControlContext {
    const existing = this.contexts.get(runId);
    if (existing) return existing;
    const ctx: RunControlContext = {
      runId,
      controller: new AbortController(),
      neuronCalls: new Set(),
      startedAt: new Date(),
      workerId,
    };
    this.contexts.set(runId, ctx);
    return ctx;
  }

  /**
   * Look up the control context for a run. Returns `undefined` when the
   * run is not registered — callers (universalNode, step executors) MUST
   * handle this gracefully because:
   *   - direct (non-`run()`) callers of universalNode have no context
   *   - tests may exercise nodes without a registered run
   *   - the registry could be missed during a race between unregister and
   *     a final between-step abort check
   */
  get(runId: string | undefined): RunControlContext | undefined {
    if (!runId) return undefined;
    return this.contexts.get(runId);
  }

  /**
   * Tear down the control context for a run. Idempotent. Called from
   * `run()`'s `finally` after success / error / abort.
   *
   * Does NOT abort any pending neuron calls — by the time a run is
   * unregistered they should already be done. The Set is cleared anyway
   * so the GC can reclaim them.
   */
  unregister(runId: string): void {
    const ctx = this.contexts.get(runId);
    if (!ctx) return;
    ctx.neuronCalls.clear();
    this.contexts.delete(runId);
  }

  /**
   * Update the registry with the current graph location. Called by
   * `universalNode` between steps. Used purely for diagnostics in the ACK
   * payload — never affects execution.
   */
  setCurrentStep(
    runId: string | undefined,
    nodeId: string | undefined,
    step: { type: string; index: number } | undefined,
  ): void {
    if (!runId) return;
    const ctx = this.contexts.get(runId);
    if (!ctx) return;
    ctx.currentNodeId = nodeId;
    ctx.currentStep = step;
  }

  /**
   * Cancel a run.
   *
   * Returns synchronously with diagnostic info for the ACK protocol. If
   * the run isn't registered (unknown runId, or already finished and
   * unregistered) returns `{ ack: false }`.
   *
   * Side effects (in order):
   *   1. Aborts the run-level AbortController. Universal-node abort checks
   *      and mid-stream neuron checks pick this up.
   *   2. Calls `.cancel()` on every registered NeuronCall. This both aborts
   *      each call's own controller (cooperative) AND schedules a force-close
   *      after the grace period (best-effort).
   */
  cancel(runId: string, reason?: string): CancelResult {
    const ctx = this.contexts.get(runId);
    if (!ctx) {
      return { ack: false, runId, reason };
    }

    // 1. Run-level abort first — this is what universalNode / executors check.
    try {
      ctx.controller.abort({ reason } as any);
    } catch {
      try { ctx.controller.abort(); } catch { /* ignore */ }
    }

    // 2. Cancel every in-flight neuron call. Snapshot the set first so
    //    iteration is safe even if a callsite removes itself synchronously.
    const calls = Array.from(ctx.neuronCalls);
    let cancelled = 0;
    for (const call of calls) {
      try {
        call.cancel({ reason });
        cancelled++;
      } catch (err) {
        console.warn(`[RunControlRegistry] NeuronCall.cancel threw for run ${runId}:`, err);
      }
    }

    return {
      ack: true,
      runId,
      workerId: ctx.workerId,
      currentNodeId: ctx.currentNodeId,
      currentStep: ctx.currentStep,
      neuronCallsCancelled: cancelled,
      reason,
    };
  }

  /**
   * Total in-flight runs. Mostly useful for tests and operational metrics.
   */
  size(): number {
    return this.contexts.size;
  }

  /**
   * Snapshot of currently registered run IDs. For tests / debugging only.
   */
  runIds(): string[] {
    return Array.from(this.contexts.keys());
  }
}

/**
 * Process singleton.
 *
 * One worker process = one registry. The registry is keyed by runId so it
 * works across concurrent runs on the same worker (which is the common case
 * for BullMQ workers with concurrency > 1).
 */
export const runControlRegistry = new RunControlRegistry();
