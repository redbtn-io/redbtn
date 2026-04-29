/**
 * EnvironmentManager — per-process pool of EnvironmentSession instances.
 *
 * # What this is
 *
 * A worker-process singleton that owns a `Map<environmentId, EnvironmentSession>`.
 * First-call to `acquire()` for a given environmentId opens a fresh session;
 * subsequent calls return the same live session and reset its idle timer.
 * After `idleTimeoutMs` of no activity (or `maxLifetimeMs` of total uptime),
 * the session closes itself and removes itself from the pool.
 *
 * # Why this exists (Phase A scope)
 *
 * Coding-agent tools (fs pack — Phase C, process pack — Phase D) make many
 * small operations against the same SSH target. Without pooling, every tool
 * call would pay the SSH handshake cost (~hundreds of ms) AND the network
 * would see a thundering herd of TCP open/close churn.
 *
 * The manager is the "thin pool" layer that turns one-shot tool calls into
 * a long-lived, drop-tolerant connection. The actual SSH machinery lives in
 * `EnvironmentSession`.
 *
 * # Phase A vs Phase B division
 *
 * Phase A (this PR) is **pure runtime**. The manager NEVER:
 *   - Touches MongoDB. Callers load the `IEnvironment` doc themselves.
 *   - Resolves secrets. Callers pass the resolved `sshKey: string` in.
 *   - Checks per-user access. Callers handle authorization themselves.
 *
 * Phase B will add a thin wrapper (in webapp / worker entry points) that
 * does the lookup + secret resolution + access check, then calls
 * `acquire()` here. Keeping the manager free of that infrastructure means
 * Phase A is testable in complete isolation (no Mongo, no Redis, no
 * `@redbtn/redsecrets`).
 *
 * # Singleton pattern
 *
 * Same shape as `runControlRegistry`: one instance per worker process,
 * exported as a module-level constant. The class is also exported so tests
 * can construct fresh instances and avoid state bleed.
 *
 * @module lib/environments/EnvironmentManager
 */

import { EnvironmentSession, type SshClientFactory, type OnExecCompleteHandler } from './EnvironmentSession';
import {
  type IEnvironment,
  type EnvironmentStatus,
  type EnvironmentLifecycleEvent,
} from './types';

/**
 * Optional dependencies passed into the manager constructor.
 *
 * Tests use `clientFactory` to swap in `MockSshClient` so they can simulate
 * drops without an SSH server. Phase B will pass `onExecComplete` to wire up
 * the Mongo `environmentLogs` write.
 */
export interface EnvironmentManagerOptions {
  clientFactory?: SshClientFactory;
  onExecComplete?: OnExecCompleteHandler;
}

export class EnvironmentManager {
  private readonly sessions = new Map<string, EnvironmentSession>();

  /**
   * Tracks in-flight `acquire()` calls so concurrent acquires for the same
   * environmentId share the same opening promise rather than racing two
   * SSH handshakes.
   */
  private readonly opening = new Map<string, Promise<EnvironmentSession>>();

  private clientFactory?: SshClientFactory;
  private onExecComplete?: OnExecCompleteHandler;

  constructor(opts: EnvironmentManagerOptions = {}) {
    this.clientFactory = opts.clientFactory;
    this.onExecComplete = opts.onExecComplete;
  }

  /**
   * Configure (or reconfigure) the global hooks. Useful for test setup and
   * for the worker entry point to wire in the Mongo-backed onExecComplete
   * after the manager singleton has been imported.
   */
  configure(opts: EnvironmentManagerOptions): void {
    if (opts.clientFactory) this.clientFactory = opts.clientFactory;
    if (opts.onExecComplete) this.onExecComplete = opts.onExecComplete;
  }

  /**
   * Get-or-open a session for an environment. Cold path opens a new SSH
   * session; warm path returns the existing session (with its idle timer
   * reset so the session stays alive).
   *
   * # Idempotent under concurrency
   *
   * If two callers race to acquire the same environment from a cold pool,
   * the second caller awaits the first caller's opening promise — they end
   * up sharing the same `EnvironmentSession` instance. This is the same
   * contract `runControlRegistry.register()` provides.
   *
   * # Caller responsibilities (NOT this method's job — see Phase B)
   *
   *   - Load the `IEnvironment` doc from Mongo.
   *   - Resolve `env.secretRef` to an actual SSH key via
   *     `@redbtn/redsecrets` (passed in here as the resolved `sshKey`).
   *   - Verify the `userId` has access to this environment.
   */
  async acquire(env: IEnvironment, sshKey: string, userId: string): Promise<EnvironmentSession> {
    const id = env.environmentId;

    // 1. Warm path — live session already in the pool.
    const existing = this.sessions.get(id);
    if (existing && (existing.state === 'open' || existing.state === 'opening' || existing.state === 'degraded')) {
      // Reset idle timer so this caller's use keeps the session alive.
      existing.touch();
      // If we're still opening, await it before returning so callers get a
      // fully-ready session (or a clean rejection).
      if (existing.state === 'opening') {
        const inFlight = this.opening.get(id);
        if (inFlight) {
          return inFlight;
        }
      }
      return existing;
    }

    // 2. Concurrent open — coalesce.
    const inFlight = this.opening.get(id);
    if (inFlight) return inFlight;

    // 3. Cold path — construct session, kick off open(), record in maps.
    const session = new EnvironmentSession({
      env,
      sshKey,
      userId,
      clientFactory: this.clientFactory,
      onExecComplete: this.onExecComplete,
    });

    // Forward lifecycle events to the manager so observers can subscribe at
    // the manager level (Phase F dashboard).
    session.on('lifecycle', (evt: EnvironmentLifecycleEvent) => {
      this.emitLifecycle(evt);
      // When a session reaches `closed` (idle/explicit/maxLifetime/etc), drop
      // it from the pool so the next acquire opens a fresh one.
      if (evt.to === 'closed') {
        const current = this.sessions.get(id);
        if (current === session) {
          this.sessions.delete(id);
        }
      }
    });

    this.sessions.set(id, session);

    const openingPromise = session.open()
      .then(() => session)
      .catch((err) => {
        // Failed to open — clean up the stale entry and propagate.
        this.sessions.delete(id);
        throw err;
      })
      .finally(() => {
        this.opening.delete(id);
      });

    this.opening.set(id, openingPromise);
    return openingPromise;
  }

  /**
   * Mark a session as no longer needed by this caller.
   *
   * Currently a **no-op** — the idle timer handles eventual close, and we
   * have no real refcounting yet (one caller releasing doesn't mean others
   * aren't using the session). Reserved for future refcounting if we ever
   * need it; the public API shape is locked in now so callers don't need
   * a forklift change later.
   */
  release(_environmentId: string): void {
    // No-op. See JSDoc.
  }

  /**
   * Force-close a session immediately. Used by:
   *   - Operator action (Studio "force close" button — Phase F).
   *   - Schema deletion (when the environment doc is removed — Phase B).
   *   - Test cleanup.
   *
   * Idempotent — closing an unknown environmentId resolves silently.
   */
  async forceClose(environmentId: string): Promise<void> {
    const session = this.sessions.get(environmentId);
    if (!session) return;
    try {
      await session.close('force-close');
    } finally {
      // The lifecycle listener should have removed it already, but defensive.
      const current = this.sessions.get(environmentId);
      if (current === session) {
        this.sessions.delete(environmentId);
      }
    }
  }

  /**
   * Public-facing snapshot of an environment's runtime state. Returns null
   * for an unknown environmentId. Used by Phase B's
   * `GET /api/v1/environments/:id/status` route and by Phase F's UI.
   */
  status(environmentId: string): EnvironmentStatus | null {
    const session = this.sessions.get(environmentId);
    if (!session) return null;
    return {
      environmentId,
      userId: session.userId,
      state: session.state,
      openedAt: session.openedAt,
      lastUsedAt: session.lastUsedAt,
      reconnectAttempt: session.reconnectAttempt,
      pendingCommandCount: (session as unknown as { pendingCommands: unknown[] }).pendingCommands.length,
      pendingCommandBytes: (session as unknown as { pendingBytes: number }).pendingBytes,
    };
  }

  /**
   * Snapshot of all currently registered environment IDs. For tests /
   * diagnostics / operational metrics. Cheap — just a map keys clone.
   */
  ids(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Number of sessions currently in the pool (any state). For tests +
   * metrics. Note: a session in `closed` state would have been removed by
   * the lifecycle listener, so this typically counts only live sessions.
   */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Close every session in the pool. Used by the worker's graceful shutdown
   * path so we don't leak SSH connections when the process exits.
   *
   * Returns when all sessions have finished closing (or an upper bound of
   * each session's individual close latency — they run in parallel).
   */
  async closeAll(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    await Promise.allSettled(sessions.map((s) => s.close('manager-close-all')));
    this.sessions.clear();
    this.opening.clear();
  }

  /**
   * For tests: clear the singleton without going through close(). Use this
   * BETWEEN tests, NOT in production — actual production teardown should
   * call `closeAll()`.
   *
   * This forcibly nukes every session reference WITHOUT awaiting their
   * close() — useful when a test injected a mock client that never resolves
   * its close events. Listeners are removed first so emitted lifecycle
   * events from the leftover sessions don't pollute later tests.
   */
  __reset(): void {
    for (const session of this.sessions.values()) {
      try { session.removeAllListeners(); } catch { /* ignore */ }
    }
    this.sessions.clear();
    this.opening.clear();
    // Also drop the listener set so leftover lifecycle subscribers from
    // previous tests don't fire on the next run.
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle event broadcast
  // ---------------------------------------------------------------------------

  private listeners = new Set<(evt: EnvironmentLifecycleEvent) => void>();

  /**
   * Subscribe to lifecycle events for ALL sessions managed by this manager.
   * Returns an unsubscribe function. Phase F (Studio UI) will use this to
   * push live state updates into a dashboard.
   *
   * Listeners are call-protected — a throw inside one listener doesn't
   * interrupt subsequent listeners.
   */
  onLifecycle(listener: (evt: EnvironmentLifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitLifecycle(evt: EnvironmentLifecycleEvent): void {
    for (const l of this.listeners) {
      try {
        l(evt);
      } catch (err) {
        console.warn(`[EnvironmentManager] lifecycle listener threw:`, err);
      }
    }
  }
}

/**
 * Process singleton. One per worker. Tests should construct their own
 * `new EnvironmentManager()` (or call `__reset()` between tests) to avoid
 * cross-test state bleed.
 */
export const environmentManager = new EnvironmentManager();
