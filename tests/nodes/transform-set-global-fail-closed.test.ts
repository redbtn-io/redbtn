import { beforeEach, describe, expect, it, vi } from 'vitest';

const setValue = vi.fn().mockResolvedValue(true);
const getValue = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/lib/globalState', () => ({
  getGlobalStateClient: () => ({ setValue, getValue }),
}));

import { executeTransform } from '../../src/lib/nodes/universal/executors/transformExecutor';
import type { TransformStepConfig } from '../../src/lib/nodes/universal/types';

// Same stray-`)` defect class as the production cliPrompt bug, but reaching the
// other mutating persistence path: set-global writes to cross-run storage.
const MALFORMED = `{{(function(){ return ['a' ? 'x' : 'y'), 'z'].join('-'); })()}}`;

const setGlobal = (over: Partial<TransformStepConfig>): TransformStepConfig =>
  ({ operation: 'set-global', namespace: 'reviewer', key: 'lastPrompt', ...over }) as TransformStepConfig;

describe('set-global fail-closed on malformed templates', () => {
  beforeEach(() => {
    setValue.mockClear();
    getValue.mockClear();
  });

  it('persists a well-formed templated value (happy path still works)', async () => {
    const state = { data: { rev: { prUrl: 'https://github.com/redbtn-io/redbtn/pull/256' } } };

    const result = await executeTransform(
      setGlobal({ value: '{{state.data.rev.prUrl}}' }),
      state,
    );

    expect(setValue).toHaveBeenCalledWith(
      'reviewer',
      'lastPrompt',
      'https://github.com/redbtn-io/redbtn/pull/256',
      expect.anything(),
    );
    expect(result._globalStateSet).toBe(true);
  });

  it('never writes the raw template when the value expression is malformed', async () => {
    await expect(
      executeTransform(setGlobal({ value: MALFORMED }), { data: {} }),
    ).rejects.toThrow(/set-global value template/);

    // The whole point: no silent persistence of unrendered source.
    expect(setValue).not.toHaveBeenCalled();
  });

  it('never addresses a slot named after a malformed namespace template', async () => {
    await expect(
      executeTransform(setGlobal({ namespace: MALFORMED, value: 'ok' }), { data: {} }),
    ).rejects.toThrow(/set-global namespace template/);

    expect(setValue).not.toHaveBeenCalled();
  });

  it('never addresses a slot named after a malformed key template', async () => {
    await expect(
      executeTransform(setGlobal({ key: MALFORMED, value: 'ok' }), { data: {} }),
    ).rejects.toThrow(/set-global key template/);

    expect(setValue).not.toHaveBeenCalled();
  });
});
