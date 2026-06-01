/**
 * loopExecutor — RunPublisher resolution regression tests.
 *
 * # What's under test
 *
 * The "infrastructure-out-of-graph-state" refactor moved the RunPublisher
 * off LangGraph state and into `runControlRegistry`, reached via
 * `getRunPublisher(state)`. `loopExecutor` was still reading the (now always
 * undefined) `loopState.runPublisher` directly, which silently disabled TWO
 * per-iteration coordination paths for EVERY loop node fleet-wide:
 *
 *   1. The EXPLICIT `state.shared` re-hydrate (cross-branch namespace).
 *   2. The IMPLICIT parallel-context auto-state overlay (peer writes to
 *      plain `state.data.x` surfaced inside a `parallel:` branch).
 *
 * Net effect: a polling loop in one parallel branch (canonically the
 * claude-assistant thinking-indicator) could not see another branch's
 * `data.thinking=false` signal, so it ran to the iteration backstop instead
 * of exiting promptly.
 *
 * These tests assert the fix: when a publisher IS resolvable via
 * `getRunPublisher`, the loop re-hydrates `state.shared` AND overlays
 * auto-state every iteration — so cross-branch writes drive a prompt exit.
 * And when NO publisher is resolvable, the loop still runs to completion
 * (graceful null handling, same as a non-parallel loop).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the step executor so the loop body is a deterministic no-op — we are
// testing the loop's publisher-driven re-hydration, not step dispatch.
vi.mock('../../src/lib/nodes/universal/stepExecutor', () => ({
  executeStep: vi.fn(async () => ({})),
}));

// Mock checkAbort to a no-op so we don't pull the run-control registry /
// abort-signal machinery into this focused test.
vi.mock('../../src/lib/nodes/universal/universalNode', () => ({
  checkAbort: vi.fn(() => {}),
}));

// Mock the run-context lookup — this is the accessor the fix introduced.
vi.mock('../../src/lib/run/contextLookup', () => ({
  getRunPublisher: vi.fn(),
}));


import { executeLoop } from '../../src/lib/nodes/universal/executors/loopExecutor';
import { executeStep } from '../../src/lib/nodes/universal/stepExecutor';
import { getRunPublisher } from '../../src/lib/run/contextLookup';

const getRunPublisherMock = vi.mocked(getRunPublisher);
const executeStepMock = vi.mocked(executeStep);

describe('loopExecutor — RunPublisher resolution (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-hydrates state.shared from the resolved publisher every iteration', async () => {
    // Publisher whose shared state flips a flag after the 2nd read, driving
    // a prompt exit well before the 50-iteration backstop.
    let sharedReads = 0;
    const getSharedState = vi.fn(async () => {
      sharedReads++;
      return { thinkingDone: sharedReads >= 3 };
    });
    getRunPublisherMock.mockReturnValue({
      getSharedState,
      getAutoState: vi.fn(async () => ({})),
    });

    const result = await executeLoop(
      {
        type: 'loop',
        maxIterations: 50,
        exitCondition: 'state.shared.thinkingDone === true',
        steps: [{ type: 'transform', config: {} }],
      } as any,
      { runId: 'run-shared', data: {} },
    );

    // Resolved ONCE before the loop, then getSharedState() called fresh per
    // iteration. Exit fired on the 3rd read — NOT the backstop.
    expect(getRunPublisherMock).toHaveBeenCalledTimes(1);
    expect(result.loopExitConditionMet).toBe(true);
    expect(result.loopIterations).toBe(3);
    expect(sharedReads).toBe(3);
  });

  it('polls the resolved publisher auto-state every iteration inside a parallel context', async () => {
    // Simulate the thinking-indicator scenario: inside a `parallel:` block the
    // loop must reach the resolved publisher's getAutoState() every iteration
    // (so a peer branch's writes can surface). Pre-fix, `loopState.runPublisher`
    // was undefined and this poll never happened. We drive the actual exit via
    // the explicit `shared` channel (its hydration shares the same resolved
    // publisher), and assert getAutoState was polled once per iteration up to
    // exit.
    let sharedReads = 0;
    const getSharedState = vi.fn(async () => {
      sharedReads++;
      // Analyst branch signals "done" on the 4th poll.
      return { thinkingDone: sharedReads >= 4 };
    });
    const getAutoState = vi.fn(async () => ({}));
    getRunPublisherMock.mockReturnValue({ getSharedState, getAutoState });

    const result = await executeLoop(
      {
        type: 'loop',
        maxIterations: 300, // the real fleet backstop
        exitCondition: 'state.shared.thinkingDone === true',
        steps: [{ type: 'transform', config: {} }],
      } as any,
      {
        runId: 'run-parallel',
        _parallelContext: { branchId: 'thinking-indicator' },
        data: { thinking: true },
      },
    );

    expect(result.loopExitConditionMet).toBe(true);
    // Single-digit exit — proving prompt cross-branch coordination, NOT the
    // 300 backstop.
    expect(result.loopIterations).toBe(4);
    expect(result.loopIterations).toBeLessThan(20);
    // The resolved publisher's auto-state was polled every iteration — this is
    // the path that was dead pre-fix.
    expect(getAutoState).toHaveBeenCalledTimes(4);
  });

  it('does NOT poll auto-state outside a parallel context', async () => {
    const getAutoState = vi.fn(async () => ({ 'data.thinking': false }));
    getRunPublisherMock.mockReturnValue({
      getSharedState: vi.fn(async () => ({})),
      getAutoState,
    });

    const result = await executeLoop(
      {
        type: 'loop',
        maxIterations: 3,
        exitCondition: 'state.data.thinking === false',
        steps: [{ type: 'transform', config: {} }],
      } as any,
      // No _parallelContext.
      { runId: 'run-no-parallel', data: { thinking: true } },
    );

    // Auto-state must be ignored — loop runs to its (small) backstop.
    expect(getAutoState).not.toHaveBeenCalled();
    expect(result.loopExitConditionMet).toBe(false);
    expect(result.loopIterations).toBe(3);
  });

  it('runs to completion when NO publisher is resolvable (graceful null handling)', async () => {
    // The pre-refactor failure mode: getRunPublisher returns undefined.
    // The loop MUST still run (just without cross-branch overlay) and never
    // throw — identical to a plain non-parallel loop.
    getRunPublisherMock.mockReturnValue(undefined);

    const result = await executeLoop(
      {
        type: 'loop',
        maxIterations: 4,
        exitCondition: 'state.data.thinking === false',
        steps: [{ type: 'transform', config: {} }],
      } as any,
      {
        runId: 'run-no-publisher',
        _parallelContext: { branchId: 'orphan' },
        data: { thinking: true },
      },
    );

    expect(result.loopExitConditionMet).toBe(false);
    expect(result.loopIterations).toBe(4);
    // Body still executed each iteration.
    expect(executeStepMock).toHaveBeenCalledTimes(4);
  });

  it('survives a publisher that throws and still completes the loop', async () => {
    // Defensive: a flaky publisher must not crash the loop — the try/catch
    // around each hydration path falls back to existing state.
    getRunPublisherMock.mockReturnValue({
      getSharedState: vi.fn(async () => { throw new Error('redis blip'); }),
      getAutoState: vi.fn(async () => { throw new Error('redis blip'); }),
    });

    const result = await executeLoop(
      {
        type: 'loop',
        maxIterations: 2,
        exitCondition: 'state.data.thinking === false',
        steps: [{ type: 'transform', config: {} }],
      } as any,
      {
        runId: 'run-flaky-publisher',
        _parallelContext: { branchId: 'flaky' },
        data: { thinking: true },
      },
    );

    expect(result.loopIterations).toBe(2);
    expect(result.loopExitConditionMet).toBe(false);
  });
});
