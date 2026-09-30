/**
 * A polling loop inside a `parallel:` block stops when a SIBLING branch failed.
 *
 * gemini-assistant (2026-09-30): the analyst branch died on ssh_shell, so it
 * never wrote the `shared.thinking = false` flag the thinking-indicator loop
 * polls; the loop (maxIterations = MAX_SAFE_INTEGER) kept sending typing for
 * minutes until the run was cancelled by hand. The failing node now leaves a
 * run-shared marker (`markParallelBranchFailure`) and the loop exits on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/nodes/universal/stepExecutor', () => ({
  executeStep: vi.fn(async () => ({})),
}));
vi.mock('../../src/lib/nodes/universal/universalNode', () => ({
  checkAbort: vi.fn(() => {}),
}));
vi.mock('../../src/lib/run/contextLookup', () => ({
  getRunPublisher: vi.fn(),
}));

import { executeLoop, siblingBranchFailure } from '../../src/lib/nodes/universal/executors/loopExecutor';
import { getRunPublisher } from '../../src/lib/run/contextLookup';
import { PARALLEL_BRANCH_FAILURE_KEY } from '../../src/lib/run/run-shared-state';

const getRunPublisherMock = vi.mocked(getRunPublisher);

const POLLER = {
  type: 'loop',
  maxIterations: Number.MAX_SAFE_INTEGER,
  exitCondition: 'state.shared && state.shared.thinking === false',
  steps: [{ type: 'delay', config: { ms: 0 } }],
} as any;

describe('loopExecutor — sibling branch failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('stops a parallel polling loop once a sibling node records a failure', async () => {
    let reads = 0;
    getRunPublisherMock.mockReturnValue({
      getSharedState: vi.fn(async () => {
        reads++;
        return reads >= 3 ? { [PARALLEL_BRANCH_FAILURE_KEY]: { node: 'analyst', error: 'ssh_shell failed', at: 1 } } : {};
      }),
      getAutoState: vi.fn(async () => ({})),
    } as any);

    const result = await executeLoop(POLLER, {
      runId: 'r1',
      data: {},
      _parallelContext: true,
      nodeConfig: { graphNodeId: 'thinking-indicator' },
    });

    expect(result.loopIterations).toBe(2);
    expect(result.loopExitConditionMet).toBe(false);
    expect(result.loopExitedOnSiblingFailure).toBe(true);
  });

  it('ignores a marker the loop\'s own node wrote, and loops outside parallel blocks are untouched', () => {
    const marker = { [PARALLEL_BRANCH_FAILURE_KEY]: { node: 'thinking-indicator', error: 'x' } };
    expect(siblingBranchFailure({ shared: marker, nodeConfig: { graphNodeId: 'thinking-indicator' } })).toBeNull();
    expect(siblingBranchFailure({ shared: marker, nodeConfig: { graphNodeId: 'other' } })).toEqual({
      node: 'thinking-indicator',
      error: 'x',
    });
    expect(siblingBranchFailure({ shared: {} })).toBeNull();
  });

  it('a non-parallel loop does not consult the marker', async () => {
    let reads = 0;
    getRunPublisherMock.mockReturnValue({
      getSharedState: vi.fn(async () => {
        reads++;
        return {
          [PARALLEL_BRANCH_FAILURE_KEY]: { node: 'analyst', error: 'boom' },
          ...(reads >= 4 ? { thinking: false } : {}),
        };
      }),
      getAutoState: vi.fn(async () => ({})),
    } as any);

    const result = await executeLoop(POLLER, { runId: 'r2', data: {}, nodeConfig: { graphNodeId: 'x' } });
    expect(result.loopIterations).toBe(4);
    expect(result.loopExitConditionMet).toBe(true);
    expect(result.loopExitedOnSiblingFailure).toBeUndefined();
  });
});
