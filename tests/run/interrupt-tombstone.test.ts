/**
 * Interrupt Tombstone Regression Test
 *
 * Repro for the orphaned-loop bug (2026-05-31): a run is cancelled/superseded,
 * `run()`'s `finally` unregisters its control context, but a DETACHED
 * parallel-branch loop (the `thinking-indicator` typing loop, polling while the
 * sibling analyst branch hangs) is still iterating. Once the live context is
 * gone, `getRunSignal()` returns `undefined` and `checkAbort()` used to no-op —
 * so the straggler ran to `maxIterations` (14.7h of Discord typing).
 *
 * The fix: `cancel()` records a tombstone keyed by runId that SURVIVES
 * `unregister()`; `checkAbort()` consults `wasCancelled(runId)` when the live
 * signal is gone, so a recently-cancelled run's straggler still aborts on its
 * next check. This is NOT a duration cap — it only fires for runs that were
 * explicitly cancelled/interrupted; healthy runs are never tombstoned.
 *
 * This exercises the RunControlRegistry directly (the universalNode wiring is a
 * trivial `if (wasCancelled(runId)) throw` consult, kept out of this unit to
 * avoid pulling the dist-only executor requires into the src test path).
 */
import { describe, it, expect } from 'vitest';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';

describe('interrupt tombstone — survives unregister so stragglers abort', () => {
  it('tombstone outlives the live context: wasCancelled stays true after unregister', () => {
    const runId = 'run_tombstone_test_1';
    runControlRegistry.register(runId, 'test-worker');
    expect(runControlRegistry.wasCancelled(runId)).toBe(false);

    // Cancel + unregister — mimics run()'s finally racing a detached loop.
    runControlRegistry.cancel(runId, 'superseded');
    runControlRegistry.unregister(runId);

    // Live context is gone (getRunSignal would return undefined) ...
    expect(runControlRegistry.get(runId)).toBeUndefined();
    // ... but the tombstone remains, so checkAbort()'s fallback still fires.
    expect(runControlRegistry.wasCancelled(runId)).toBe(true);
  });

  it('cancel() on an unknown run does not create a tombstone (ack:false)', () => {
    const res = runControlRegistry.cancel('run_never_registered');
    expect(res.ack).toBe(false);
    expect(runControlRegistry.wasCancelled('run_never_registered')).toBe(false);
  });

  it('a healthy run that completes WITHOUT cancellation is never tombstoned', () => {
    const runId = 'run_tombstone_test_3';
    runControlRegistry.register(runId, 'test-worker');
    runControlRegistry.unregister(runId); // normal completion — never cancelled
    expect(runControlRegistry.wasCancelled(runId)).toBe(false);
  });

  it('wasCancelled is false for unknown / missing runIds', () => {
    expect(runControlRegistry.wasCancelled('never-seen')).toBe(false);
    expect(runControlRegistry.wasCancelled(undefined)).toBe(false);
  });
});
