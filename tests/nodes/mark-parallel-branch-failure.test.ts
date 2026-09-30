import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/run/contextLookup', () => ({
  getRunPublisher: vi.fn(),
  getMeteringClient: vi.fn(),
}));

import { markParallelBranchFailure } from '../../src/lib/nodes/universal/universalNode';
import { getRunPublisher } from '../../src/lib/run/contextLookup';
import { PARALLEL_BRANCH_FAILURE_KEY } from '../../src/lib/run/run-shared-state';

describe('markParallelBranchFailure', () => {
  it('writes the run-shared marker for a node inside a parallel block', async () => {
    const setSharedField = vi.fn(async () => {});
    vi.mocked(getRunPublisher).mockReturnValue({ setSharedField } as any);
    await markParallelBranchFailure({ _parallelContext: true }, 'analyst', 'Step 7 (tool) failed: ssh');
    expect(setSharedField).toHaveBeenCalledWith(
      PARALLEL_BRANCH_FAILURE_KEY,
      expect.objectContaining({ node: 'analyst', error: 'Step 7 (tool) failed: ssh' }),
    );
  });

  it('is a no-op outside parallel blocks and never throws', async () => {
    const setSharedField = vi.fn(async () => {
      throw new Error('redis down');
    });
    vi.mocked(getRunPublisher).mockReturnValue({ setSharedField } as any);
    await markParallelBranchFailure({}, 'n', 'e');
    expect(setSharedField).not.toHaveBeenCalled();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(markParallelBranchFailure({ _parallelContext: true }, 'n', 'e')).resolves.toBeUndefined();
  });
});
