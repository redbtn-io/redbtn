import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * A busy conversation lock must not publish a terminal run error when the
 * caller is going to re-queue the run (worker chat lock-contention retry):
 * stream subscribers would see a failed turn seconds before the retry
 * succeeds. The caller's final attempt (no lockBusyRetry) still publishes.
 */

const publishRunError = vi.fn(async () => undefined);

vi.mock('mongoose', () => ({
  models: {},
  Schema: class Schema {},
  model: () => ({ findById: () => ({ lean: async () => null }) }),
}));

vi.mock('../../src/lib/run', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  class BusyLock {
    async acquire() {
      return null;
    }
  }
  return { ...actual, RunLock: BusyLock, publishRunError };
});

const red = {
  redis: {},
  graphRegistry: { getGraph: async () => ({ config: { name: 'g' } }) },
} as any;

describe('lock-busy publish', () => {
  beforeEach(() => publishRunError.mockClear());

  it('publishes nothing when the caller will retry', async () => {
    const { run } = await import('../../src/functions/run');
    await expect(
      run(red, { message: 'hi' }, { userId: 'u1', runId: 'run_a', conversationId: 'c1', graphId: 'g', lockBusyRetry: true }),
    ).rejects.toThrow(/already has an active run/);
    expect(publishRunError).not.toHaveBeenCalled();
  });

  it('publishes the error on the final attempt', async () => {
    const { run } = await import('../../src/functions/run');
    await expect(
      run(red, { message: 'hi' }, { userId: 'u1', runId: 'run_b', conversationId: 'c1', graphId: 'g' }),
    ).rejects.toThrow(/already has an active run/);
    expect(publishRunError).toHaveBeenCalledTimes(1);
    expect(String((publishRunError.mock.calls[0] as unknown[])[2])).toContain('[run:lock-busy]');
  });
});
