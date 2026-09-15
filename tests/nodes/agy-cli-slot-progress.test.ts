/**
 * A QUEUED agy-cli step is not a STALLED run.
 *
 * `claude-code` learned this in #463 and `agy-cli` did not, which is the whole
 * reason the queue now lives in one file: both executors serialise CLI children
 * per replica (`AGY_CLI_MAX_CONCURRENT`, default 2) and the run-level watchdog
 * interrupts a run whose `lastProgressAt` has not moved for 30 minutes. A step
 * waiting for a slot writes nothing until its CLI starts, so a step that waited
 * out that window had its run killed before it had spawned anything at all.
 *
 * One tick a minute, on the channel the step already has, for as long as it is
 * queued and not one tick longer. This drives the real semaphore with fake
 * timers — no CLI, no Redis, no publisher.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  acquireSlot,
  releaseSlot,
  __agySlotsInUse,
} from '../../src/lib/nodes/universal/executors/agyCliExecutor';
import { SLOT_WAIT_PROGRESS_INTERVAL_MS } from '../../src/lib/nodes/universal/executors/cli-slot';

const OLD_MAX = process.env.AGY_CLI_MAX_CONCURRENT;

beforeEach(() => {
  process.env.AGY_CLI_MAX_CONCURRENT = '1';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // Never leave the worker-wide semaphore occupied for the next test.
  while (__agySlotsInUse() > 0) releaseSlot();
  if (OLD_MAX === undefined) delete process.env.AGY_CLI_MAX_CONCURRENT;
  else process.env.AGY_CLI_MAX_CONCURRENT = OLD_MAX;
});

describe('agy-cli slot queue — progress while waiting', () => {
  it('reports once per interval while queued, and stops the moment it is admitted', async () => {
    await acquireSlot(undefined, 1000); // the long-running child holds the only slot
    expect(__agySlotsInUse()).toBe(1);

    const reasons: string[] = [];
    const queued = acquireSlot(undefined, 60 * 60_000, (r) => reasons.push(r));

    await vi.advanceTimersByTimeAsync(3 * SLOT_WAIT_PROGRESS_INTERVAL_MS);
    expect(reasons).toEqual([
      'waiting for a CLI slot (1 ahead)',
      'waiting for a CLI slot (1 ahead)',
      'waiting for a CLI slot (1 ahead)',
    ]);

    releaseSlot(); // the child finishes → the queued step is admitted
    await queued;
    await vi.advanceTimersByTimeAsync(5 * SLOT_WAIT_PROGRESS_INTERVAL_MS);
    expect(reasons).toHaveLength(3); // a running step reports through its CLI, not here
    expect(__agySlotsInUse()).toBe(1);
  });

  it('counts everything ahead of this step — running plus queued before it', async () => {
    await acquireSlot(undefined, 1000);
    const first = acquireSlot(undefined, 60 * 60_000, () => {});
    const second: string[] = [];
    const behind = acquireSlot(undefined, 60 * 60_000, (r) => second.push(r));

    await vi.advanceTimersByTimeAsync(SLOT_WAIT_PROGRESS_INTERVAL_MS);
    expect(second).toEqual(['waiting for a CLI slot (2 ahead)']);

    releaseSlot();
    await first;
    await vi.advanceTimersByTimeAsync(SLOT_WAIT_PROGRESS_INTERVAL_MS);
    expect(second).toEqual(['waiting for a CLI slot (2 ahead)', 'waiting for a CLI slot (1 ahead)']);
    releaseSlot();
    await behind;
  });

  it('never reports for a step that gets a slot straight away, and stops on a queue timeout', async () => {
    const free: string[] = [];
    await acquireSlot(undefined, 1000, (r) => free.push(r));
    expect(free).toEqual([]); // nothing queued ⇒ nothing to say

    const timedOut: string[] = [];
    const doomed = acquireSlot(undefined, 90_000, (r) => timedOut.push(r));
    const assertion = expect(doomed).rejects.toMatchObject({ code: 'agy_queue_timeout' });
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
    expect(timedOut).toHaveLength(1); // one tick at 60 s, none after the failure

    await vi.advanceTimersByTimeAsync(5 * SLOT_WAIT_PROGRESS_INTERVAL_MS);
    expect(timedOut).toHaveLength(1);
  });
});
