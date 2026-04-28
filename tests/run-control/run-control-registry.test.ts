/**
 * RunControlRegistry — process-level run cancellation contract tests.
 *
 * # What's under test
 *
 * The registry is the foundation of mid-execution interrupt: it gives every
 * step executor (universalNode, neuronExecutor, toolExecutor, stepExecutor)
 * a way to read an AbortSignal that survives LangGraph's checkpoint round-
 * trip (which strips state-stashed AbortControllers).
 *
 * These tests assert the contract:
 *   - register / get / unregister behave correctly
 *   - cancel() trips the controller signal AND every registered NeuronCall
 *   - cancel() returns ack=true with diagnostic data when the run is known
 *   - cancel() returns ack=false when the run is unknown
 *   - NeuronCall.cancel() aborts cooperatively + schedules force-close
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RunControlRegistry,
  NeuronCall,
} from '../../src/lib/run/RunControlRegistry';

describe('RunControlRegistry — registry primitives', () => {
  let registry: RunControlRegistry;

  beforeEach(() => {
    registry = new RunControlRegistry();
  });

  it('register() creates a context with a fresh AbortController', () => {
    const ctx = registry.register('run-1', 'worker-a');
    expect(ctx.runId).toBe('run-1');
    expect(ctx.workerId).toBe('worker-a');
    expect(ctx.controller).toBeInstanceOf(AbortController);
    expect(ctx.controller.signal.aborted).toBe(false);
    expect(ctx.neuronCalls.size).toBe(0);
    expect(ctx.startedAt).toBeInstanceOf(Date);
  });

  it('register() is idempotent for the same runId', () => {
    const a = registry.register('run-1', 'worker-a');
    const b = registry.register('run-1', 'worker-b');
    expect(a).toBe(b); // same instance returned
  });

  it('get() returns the registered context', () => {
    const ctx = registry.register('run-1', 'worker-a');
    expect(registry.get('run-1')).toBe(ctx);
  });

  it('get() returns undefined for unknown runId', () => {
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('get() handles undefined/null safely', () => {
    expect(registry.get(undefined)).toBeUndefined();
  });

  it('unregister() removes the context', () => {
    registry.register('run-1', 'worker-a');
    registry.unregister('run-1');
    expect(registry.get('run-1')).toBeUndefined();
  });

  it('unregister() is idempotent', () => {
    registry.unregister('does-not-exist');
    registry.unregister('does-not-exist');
    expect(registry.get('does-not-exist')).toBeUndefined();
  });

  it('size() / runIds() reflect registered runs', () => {
    expect(registry.size()).toBe(0);
    registry.register('a', 'w');
    registry.register('b', 'w');
    expect(registry.size()).toBe(2);
    expect(new Set(registry.runIds())).toEqual(new Set(['a', 'b']));
  });

  it('setCurrentStep() updates diagnostics on a known run', () => {
    registry.register('run-1', 'worker-a');
    registry.setCurrentStep('run-1', 'planner', { type: 'neuron', index: 0 });
    const ctx = registry.get('run-1')!;
    expect(ctx.currentNodeId).toBe('planner');
    expect(ctx.currentStep).toEqual({ type: 'neuron', index: 0 });
  });

  it('setCurrentStep() is a no-op on unknown run', () => {
    // Should not throw
    registry.setCurrentStep('unknown', 'x', { type: 'neuron', index: 0 });
  });
});

describe('RunControlRegistry — cancel()', () => {
  let registry: RunControlRegistry;

  beforeEach(() => {
    registry = new RunControlRegistry();
  });

  it('returns ack=false for unknown run', () => {
    const result = registry.cancel('unknown', 'because');
    expect(result.ack).toBe(false);
    expect(result.runId).toBe('unknown');
    expect((result as any).reason).toBe('because');
  });

  it('aborts the controller signal on a known run', () => {
    const ctx = registry.register('run-1', 'worker-a');
    expect(ctx.controller.signal.aborted).toBe(false);
    const result = registry.cancel('run-1', 'test');
    expect(result.ack).toBe(true);
    expect(ctx.controller.signal.aborted).toBe(true);
  });

  it('cancel() ACK includes workerId, currentNodeId, currentStep diagnostics', () => {
    registry.register('run-1', 'worker-a');
    registry.setCurrentStep('run-1', 'planner', { type: 'neuron', index: 2 });
    const result = registry.cancel('run-1', 'because');
    expect(result.ack).toBe(true);
    if (result.ack) {
      expect(result.workerId).toBe('worker-a');
      expect(result.currentNodeId).toBe('planner');
      expect(result.currentStep).toEqual({ type: 'neuron', index: 2 });
      expect(result.neuronCallsCancelled).toBe(0);
      expect(result.reason).toBe('because');
    }
  });

  it('cancel() walks every registered NeuronCall and cancels each', () => {
    const ctx = registry.register('run-1', 'worker-a');
    const callA = new NeuronCall('neuron-a');
    const callB = new NeuronCall('neuron-b');
    ctx.neuronCalls.add(callA);
    ctx.neuronCalls.add(callB);
    expect(callA.controller.signal.aborted).toBe(false);
    expect(callB.controller.signal.aborted).toBe(false);
    const result = registry.cancel('run-1');
    expect(result.ack).toBe(true);
    if (result.ack) {
      expect(result.neuronCallsCancelled).toBe(2);
    }
    expect(callA.controller.signal.aborted).toBe(true);
    expect(callB.controller.signal.aborted).toBe(true);
  });

  it('cancel() forwards reason via AbortSignal.reason on the controller', () => {
    const ctx = registry.register('run-1', 'worker-a');
    registry.cancel('run-1', 'user-clicked-stop');
    const reason = ctx.controller.signal.reason as any;
    // Reason is wrapped in { reason } to match the legacy interrupt format.
    // Either flavor is acceptable as long as the string is reachable.
    const extracted =
      typeof reason === 'string' ? reason : reason?.reason;
    expect(extracted).toBe('user-clicked-stop');
  });

  it('cancel() is robust against NeuronCall.cancel throwing', () => {
    const ctx = registry.register('run-1', 'worker-a');
    const broken = new NeuronCall('boom');
    // Force cancel() to throw
    (broken as any).cancel = () => { throw new Error('intentional'); };
    const ok = new NeuronCall('ok');
    ctx.neuronCalls.add(broken);
    ctx.neuronCalls.add(ok);
    const result = registry.cancel('run-1');
    expect(result.ack).toBe(true);
    if (result.ack) {
      // Only the working call counts toward cancellations; broken throws and
      // is logged as a warn but doesn't crash cancel().
      expect(result.neuronCallsCancelled).toBe(1);
    }
    expect(ok.controller.signal.aborted).toBe(true);
  });

  it('after cancel(), get() still returns the context (not torn down)', () => {
    registry.register('run-1', 'worker-a');
    registry.cancel('run-1');
    // Tear-down is the caller's responsibility — explicit unregister().
    expect(registry.get('run-1')).toBeDefined();
  });
});

describe('NeuronCall — direct cancellation primitives', () => {
  it('starts un-aborted', () => {
    const call = new NeuronCall('n');
    expect(call.controller.signal.aborted).toBe(false);
  });

  it('cancel() trips the controller signal cooperatively', () => {
    const call = new NeuronCall('n');
    call.cancel();
    expect(call.controller.signal.aborted).toBe(true);
  });

  it('cancel() is idempotent (second call is a no-op)', () => {
    const call = new NeuronCall('n');
    call.cancel({ reason: 'first' });
    // Should not throw or produce a different signal state
    call.cancel({ reason: 'second' });
    expect(call.controller.signal.aborted).toBe(true);
  });

  it('cancel() forwards the reason via AbortSignal.reason', () => {
    const call = new NeuronCall('n');
    call.cancel({ reason: 'because' });
    expect(call.controller.signal.reason).toBe('because');
  });

  it('cancel() schedules force-close on underlyingClient.abort if present', async () => {
    const call = new NeuronCall('n');
    let forceCloseCalled = false;
    call.underlyingClient = {
      abort: () => { forceCloseCalled = true; },
    };
    call.cancel({ gracePeriodMs: 10 });
    // Cooperative abort fires immediately
    expect(call.controller.signal.aborted).toBe(true);
    // Force-close fires after the grace period
    expect(forceCloseCalled).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(forceCloseCalled).toBe(true);
  });

  it('cancel() with no underlyingClient is a clean cooperative-only cancel', async () => {
    const call = new NeuronCall('n');
    call.cancel({ gracePeriodMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(call.controller.signal.aborted).toBe(true);
  });
});

describe('RunControlRegistry — survives state JSON round-trip (regression)', () => {
  let registry: RunControlRegistry;

  beforeEach(() => {
    registry = new RunControlRegistry();
  });

  it('the signal source is independent of any state object', () => {
    // This is the WHOLE POINT of the registry — runaway proof that the
    // signal is reachable from any code path that knows the runId, even
    // after the state has been JSON.parse(JSON.stringify(state))'d.
    const ctx = registry.register('run-99', 'worker-a');
    const fakeState = {
      runId: 'run-99',
      data: { runId: 'run-99' },
      // Notice: NO _abortController on the round-tripped state. This
      // exactly mirrors what MongoCheckpointer leaves us with.
    };
    const stripped = JSON.parse(JSON.stringify(fakeState));
    // Imagine an executor reading the signal AFTER the round trip:
    const ctxAfterRoundTrip = registry.get(stripped.runId);
    expect(ctxAfterRoundTrip).toBe(ctx);
    expect(ctxAfterRoundTrip!.controller.signal).toBe(ctx.controller.signal);
    // And cancellation reaches it:
    registry.cancel('run-99', 'late');
    expect(ctxAfterRoundTrip!.controller.signal.aborted).toBe(true);
  });
});
