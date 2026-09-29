/**
 * Transform `increment` / `decrement` on a global-state counter.
 *
 * When input and output are the SAME `globalState.<ns>.<key>`, the step must
 * use the webapp's atomic increment (one conditional Mongo update) instead of
 * read + whole-value write, which lost updates under concurrency (and read
 * through the client's 5s cache). Semantics preserved: missing / non-number
 * values count from 0 (`onNonNumber: 'reset'`), `value` of 0/NaN means 1.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setValue = vi.fn().mockResolvedValue(true);
const getValue = vi.fn().mockResolvedValue(5);
const increment = vi.fn();

vi.mock('../../src/lib/globalState', () => ({
  getGlobalStateClient: () => ({ setValue, getValue, increment }),
}));

import { executeTransform, sameGlobalStateKey } from '../../src/lib/nodes/universal/executors/transformExecutor';
import type { TransformStepConfig } from '../../src/lib/nodes/universal/types';

const step = (over: Partial<TransformStepConfig>): TransformStepConfig =>
  ({ operation: 'increment', inputField: 'globalState.stats.runs', outputField: 'globalState.stats.runs', ...over }) as TransformStepConfig;

describe('sameGlobalStateKey', () => {
  it('matches only identical three-segment globalState paths', () => {
    expect(sameGlobalStateKey('globalState.a.b', 'globalState.a.b')).toEqual({ namespace: 'a', key: 'b' });
    expect(sameGlobalStateKey('globalState.a.b', 'globalState.a.c')).toBeNull();
    expect(sameGlobalStateKey('globalState.a.b.c', 'globalState.a.b.c')).toBeNull();
    expect(sameGlobalStateKey('data.count', 'data.count')).toBeNull();
    expect(sameGlobalStateKey(undefined, 'globalState.a.b')).toBeNull();
  });
});

describe('transform increment on a global counter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    increment.mockResolvedValue({ supported: true, ok: true, value: 6 });
  });

  it('uses the atomic increment — no read, no whole-value write', async () => {
    const result = await executeTransform(step({}), { data: { userId: 'u1', graphId: 'g1' } });
    expect(increment).toHaveBeenCalledWith('stats', 'runs', 1, {
      initial: 0,
      onNonNumber: 'reset',
      ttlSeconds: undefined,
      description: undefined,
    });
    expect(getValue).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(result).toEqual({ _globalStateSet: true, _globalStateKey: 'stats.runs' });
  });

  it('decrement sends a negative delta; value / ttl / description are passed through', async () => {
    await executeTransform(
      step({ operation: 'decrement', value: '{{state.data.n}}', ttlSeconds: 60, description: 'd' } as Partial<TransformStepConfig>),
      { data: { n: 3 } },
    );
    expect(increment).toHaveBeenCalledWith('stats', 'runs', -3, expect.objectContaining({ ttlSeconds: 60, description: 'd' }));
  });

  it('keeps the historical "0 or NaN means 1" amount rule', async () => {
    await executeTransform(step({ value: 0 } as Partial<TransformStepConfig>), { data: {} });
    expect(increment).toHaveBeenCalledWith('stats', 'runs', 1, expect.anything());
  });

  it('reports a failed atomic write as _globalStateSet: false', async () => {
    increment.mockResolvedValue({ supported: true, ok: false, error: 'Forbidden' });
    const result = await executeTransform(step({}), { data: {} });
    expect(result).toEqual({ _globalStateSet: false, _globalStateKey: 'stats.runs' });
    expect(setValue).not.toHaveBeenCalled();
  });

  it('falls back to read-modify-write when the webapp has no atomic endpoint', async () => {
    increment.mockResolvedValue({ supported: false });
    const result = await executeTransform(step({}), { data: {} });
    expect(getValue).toHaveBeenCalledWith('stats', 'runs');
    expect(setValue).toHaveBeenCalledWith('stats', 'runs', 6, expect.anything());
    expect(result._globalStateSet).toBe(true);
  });

  it('different input and output keys keep the plain read + write path', async () => {
    const result = await executeTransform(step({ outputField: 'globalState.stats.other' }), { data: {} });
    expect(increment).not.toHaveBeenCalled();
    expect(setValue).toHaveBeenCalledWith('stats', 'other', 6, expect.anything());
    expect(result._globalStateSet).toBe(true);
  });

  it('local-state increments are untouched', async () => {
    const result = await executeTransform(
      step({ inputField: 'data.count', outputField: 'data.count' }),
      { data: { count: 2 } },
    );
    expect(increment).not.toHaveBeenCalled();
    expect(result).toEqual({ 'data.count': 3 });
  });
});
