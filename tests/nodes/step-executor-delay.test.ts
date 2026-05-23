import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeStep } from '../../src/lib/nodes/universal/stepExecutor';
import type { UniversalStep } from '../../src/lib/nodes/universal/types';

vi.mock('../../src/lib/globalState', () => ({
  getGlobalStateClient: () => ({
    resolveTemplatePath: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

async function expectDelayToResolveAfter(step: UniversalStep, expectedMs: number, parameters: Record<string, any> = {}) {
  let settled = false;
  const promise = executeStep(step, {}, parameters).then((result) => {
    settled = true;
    return result;
  });

  await vi.advanceTimersByTimeAsync(Math.max(expectedMs - 1, 0));
  if (expectedMs > 0) {
    expect(settled).toBe(false);
  }

  await vi.advanceTimersByTimeAsync(expectedMs > 0 ? 1 : 0);
  await expect(promise).resolves.toEqual({});
  expect(settled).toBe(true);
}

describe('stepExecutor delay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for a literal numeric ms value', async () => {
    await expectDelayToResolveAfter(
      { type: 'delay', config: { ms: 25 } } as UniversalStep,
      25,
    );
  });

  it('waits for a numeric string ms value', async () => {
    await expectDelayToResolveAfter(
      { type: 'delay', config: { ms: '30' } } as UniversalStep,
      30,
    );
  });

  it('resolves a templated parameters ms value before waiting', async () => {
    await expectDelayToResolveAfter(
      { type: 'delay', config: { ms: '{{parameters.loopDelay}}' } } as UniversalStep,
      40,
      { loopDelay: 40 },
    );
  });

  it('falls back to 1000ms for a non-numeric resolved ms value', async () => {
    await expectDelayToResolveAfter(
      { type: 'delay', config: { ms: '{{parameters.loopDelay}}' } } as UniversalStep,
      1000,
      { loopDelay: 'not-a-number' },
    );
  });
});
