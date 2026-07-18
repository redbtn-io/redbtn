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
   * Tool-supplied cancel callbacks. Long-running tools (ssh_shell,
   * ssh_run_async, etc) register cleanup hooks here on entry and remove
   * them on exit. cancel() fires them ALL before signalling the
   * controller — gives tools the chance to kill remote work that
   * doesn't naturally die when the SSH stream closes (e.g., daemonized
   * `claude` invocations on a remote host).
   *
   * Each callback is fire-and-forget. Errors are swallowed and logged.
   * Callbacks should return quickly (start the kill, don't await
   * completion).
   */
  onCancelCallbacks: Set<() => void | Promise<void>>;
  /**
   * Last-known graph location — populated by universalNode. Used in the
   * ACK payload so the interrupt endpoint can report what was running.
   */
  currentNodeId?: string;
  currentStep?: { type: string; index: number };
  startedAt: Date;
  workerId: string;
  /**
   * Run-scoped infrastructure objects. These used to live as top-level
   * channels on `RedGraphState` and got stuffed into LangGraph's
   * `state.__start__`, where the checkpoint serializer would try to JSON-
   * serialize them. That blew up silently because `runPublisher.redlog`
   * carries a Mongoose-internal `Symbol(@@mdb.bson.type)` — fast-safe-stringify
   * catches the `JSON.stringify` throw and substitutes a placeholder string,
   * which on reload deserializes to a non-object and crashes LangGraph's
   * `_first()` with `Cannot read properties of undefined (reading '__input__')`.
   *
   * Moving them to the registry follows the same pattern that already worked
   * for `_abortController` (see file-level docstring): infrastructure stays
   * in the worker process, only primitives (runId, userId) flow through
   * checkpoints, and read-sites use the `getX(state)` helpers in
   * `contextLookup.ts` which fall back to `state.X` for direct/test callers.
   */
  runPublisher?: any;
  neuronRegistry?: any;
  mcpClient?: any;
  memory?: any;
  connectionManager?: any;
  graphRegistry?: any;
  mcpRegistry?: any;
  logger?: any;
  graphPublisher?: any;
  /** redToken usage-metering client (NeuronMeteringClient). Emits one usage
   *  event per LLM call to the `usage:events` Redis stream. Optional + fully
   *  fail-safe — a metering outage never affects the run. */
  meteringClient?: any;
  /**
   * Capability profile for the data-permissions layer (State + Knowledge).
   * Resolved from the graph config at run start and read by the native-tool
   * dispatch chokepoint via `getCapabilityProfile(state)`. `undefined` means
   * the run is UNPROFILED → unrestricted (backward-compatible). Lives here, not
   * in graph state, so a profiled jail can't be stripped by a checkpoint
   * round-trip or a state-mutating step.
   */
  capabilityProfile?: any;
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
   * Tombstones for runs that were cancelled / interrupted.
   *
   * A run's live context is removed by `unregister()` in `run()`'s `finally`
   * — but a DETACHED parallel-branch operation (the canonical case: the
   * `thinking-indicator` typing loop, which polls in a parallel branch while
   * the sibling analyst branch hangs) can still be mid-flight at that moment.
   * Once the context is gone, `getRunSignal()` returns `undefined` and
   * `checkAbort()` no-ops — so the straggler runs free to `maxIterations`
   * (14.7h of Discord typing in the wild). The tombstone lets `checkAbort()`
   * still detect the cancellation by `runId` for a grace window and stop it.
   *
   * Map: `runId` -> cancelledAt epoch ms. NOT a duration cap — it only fires
   * for runs that were explicitly cancelled/interrupted; healthy long runs
   * keep their live context and are never tombstoned.
   */
  private cancelledTombstones = new Map<string, number>();

  /**
   * How long a cancelled-run tombstone is honoured. A straggler loop checks
   * abort at least once per iteration (seconds), so this only needs to cover
   * the window between cancel→unregister and the loop's next check; 15 min is
   * a generous safety margin that still bounds memory.
   */
  private static readonly TOMBSTONE_TTL_MS = 15 * 60 * 1000;

  /**
   * Create + register a new control context for a run. Idempotent — if a
   * context already exists for `runId` it's returned as-is (the engine
   * handles run-id collisions at a higher layer).
   *
   * The optional `infra` argument attaches run-scoped infrastructure objects
   * (RunPublisher, NeuronRegistry, etc.) — see `RunControlContext` docstring
   * for why these live here instead of in graph state. When `register()` is
   * called a second time for the same runId, infra objects in the second
   * call merge into the existing context (subgraphs inherit the parent's
   * registry without needing a new registration).
   */
  register(
    runId: string,
    workerId: string,
    infra?: Partial<Pick<
      RunControlContext,
      | 'runPublisher'
      | 'neuronRegistry'
      | 'mcpClient'
      | 'memory'
      | 'connectionManager'
      | 'graphRegistry'
      | 'mcpRegistry'
      | 'logger'
      | 'graphPublisher'
      | 'meteringClient'
      | 'capabilityProfile'
    >>,
  ): RunControlContext {
    const existing = this.contexts.get(runId);
    if (existing) {
      if (infra) Object.assign(existing, infra);
      return existing;
    }
    const ctx: RunControlContext = {
      runId,
      controller: new AbortController(),
      neuronCalls: new Set(),
      onCancelCallbacks: new Set(),
      startedAt: new Date(),
      workerId,
      ...(infra ?? {}),
    };
    this.contexts.set(runId, ctx);
    return ctx;
  }

  /**
   * Attach (or replace) infrastructure objects on an already-registered run.
   * Useful when the registration site doesn't have all infra in scope yet
   * (e.g., RunPublisher is constructed after `register()` is called).
   */
  attachInfra(
    runId: string,
    infra: Partial<Pick<
      RunControlContext,
      | 'runPublisher'
      | 'neuronRegistry'
      | 'mcpClient'
      | 'memory'
      | 'connectionManager'
      | 'graphRegistry'
      | 'mcpRegistry'
      | 'logger'
      | 'graphPublisher'
      | 'meteringClient'
      | 'capabilityProfile'
    >>,
  ): void {
    const ctx = this.contexts.get(runId);
    if (!ctx) return;
    Object.assign(ctx, infra);
  }

  /**
   * Register a tool-supplied cancel callback. Returns an unregister
   * function — callers MUST invoke it when the tool exits normally so the
   * registry doesn't accumulate stale callbacks. Returns a no-op
   * unregister if the run isn't registered (caller doesn't need to
   * special-case missing-context).
   *
   * If the run's controller is ALREADY aborted at registration time (the
   * tool lost the race — e.g. a slow SSH handshake completing after the
   * interrupt already fired `cancel()`), the callback would otherwise sit
   * in the Set forever: `cancel()` only walks it once, at the moment of
   * cancellation, so a hook added afterwards would never run and the tool
   * would keep executing on a "cancelled" run with no cleanup. Detect that
   * and invoke the callback immediately instead of registering it.
   */
  registerOnCancel(runId: string | undefined, cb: () => void | Promise<void>): () => void {
    if (!runId) return () => {};
    const ctx = this.contexts.get(runId);
    if (!ctx) return () => {};
    if (ctx.controller.signal.aborted) {
      this.invokeCancelCallback(runId, cb);
      return () => {};
    }
    ctx.onCancelCallbacks.add(cb);
    return () => {
      const c = this.contexts.get(runId);
      c?.onCancelCallbacks.delete(cb);
    };
  }

  /**
   * Fire a single onCancel callback with the same fire-and-forget error
   * handling `cancel()` uses for the whole set: synchronous throws and
   * async rejections are both swallowed (logged, not propagated) so one
   * misbehaving tool cleanup hook can never block or crash cancellation.
   */
  private invokeCancelCallback(runId: string, cb: () => void | Promise<void>): void {
    try {
      const r = cb();
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(err => console.warn(`[RunControlRegistry] onCancel callback threw for run ${runId}:`, err));
      }
    } catch (err) {
      console.warn(`[RunControlRegistry] onCancel callback threw for run ${runId}:`, err);
    }
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
    ctx.onCancelCallbacks.clear();
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

    // 1b. Tombstone the runId. A detached straggler (e.g. the thinking-indicator
    //     parallel loop) may still be iterating after `run()`'s finally calls
    //     `unregister()` and removes the live context above. Once that happens
    //     `getRunSignal()` returns undefined and `checkAbort()` can no longer
    //     see this aborted signal — so it consults the tombstone instead.
    this.cancelledTombstones.set(runId, Date.now());
    this.pruneTombstones();

    // 2. Fire tool-supplied cancel callbacks BEFORE walking neuron calls.
    //    Tools (ssh_shell, etc) need a chance to start killing remote
    //    work — the AbortController flip won't propagate to processes
    //    running on a different host. Fire-and-forget; we don't await.
    const callbacks = Array.from(ctx.onCancelCallbacks);
    for (const cb of callbacks) {
      this.invokeCancelCallback(runId, cb);
    }

    // 3. Cancel every in-flight neuron call. Snapshot the set first so
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
   * Was this run cancelled / interrupted within the tombstone TTL?
   *
   * Used by `checkAbort()` as a fallback when the live context has already
   * been unregistered but a detached operation is still running. Returns
   * false for unknown or expired runIds. Prunes the checked entry on expiry.
   */
  wasCancelled(runId: string | undefined): boolean {
    if (!runId) return false;
    const at = this.cancelledTombstones.get(runId);
    if (at === undefined) return false;
    if (Date.now() - at > RunControlRegistry.TOMBSTONE_TTL_MS) {
      this.cancelledTombstones.delete(runId);
      return false;
    }
    return true;
  }

  /** Drop tombstones past their TTL. Called opportunistically from cancel(). */
  private pruneTombstones(): void {
    const now = Date.now();
    for (const [rid, at] of this.cancelledTombstones) {
      if (now - at > RunControlRegistry.TOMBSTONE_TTL_MS) {
        this.cancelledTombstones.delete(rid);
      }
    }
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
