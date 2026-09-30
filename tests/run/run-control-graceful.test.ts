import { describe, test, expect } from 'vitest';
import { RunControlRegistry, NeuronCall, runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import { checkAbort, RunInterruptedError } from '../../src/lib/nodes/universal/universalNode';

describe('RunControlRegistry — graceful stop & steering', () => {
  test('requestGracefulStop sets gracefulStopRequested and cancels neuron calls without firing tool cancel callbacks', () => {
    const registry = new RunControlRegistry();
    const ctx = registry.register('run-steer-1', 'worker-1');

    let toolCancelled = false;
    registry.registerOnCancel('run-steer-1', () => {
      toolCancelled = true;
    });

    const neuronCall = new NeuronCall('neuron-1');
    ctx.neuronCalls.add(neuronCall);

    expect(registry.isGracefulStopRequested('run-steer-1')).toBe(false);
    expect(neuronCall.controller.signal.aborted).toBe(false);

    const ok = registry.requestGracefulStop('run-steer-1', 'steered by user');
    expect(ok).toBe(true);
    expect(registry.isGracefulStopRequested('run-steer-1')).toBe(true);

    // Neuron call is stopped immediately
    expect(neuronCall.controller.signal.aborted).toBe(true);

    // Tool cancel callbacks are NOT fired (in-flight tools finish cleanly)
    expect(toolCancelled).toBe(false);

    // Run controller is NOT aborted immediately
    expect(ctx.controller.signal.aborted).toBe(false);
  });

  test('checkAbort throws RunInterruptedError when graceful stop is requested', () => {
    runControlRegistry.register('run-steer-2', 'worker-1');
    runControlRegistry.requestGracefulStop('run-steer-2', 'custom steer reason');

    const state = { runId: 'run-steer-2' };
    expect(() => checkAbort(state)).toThrow(RunInterruptedError);
    try {
      checkAbort(state);
    } catch (e: any) {
      expect(e.reason).toBe('custom steer reason');
    }

    runControlRegistry.unregister('run-steer-2');
  });
});
