/**
 * NeuronRegistry.callNeuron — RunControlRegistry integration tests.
 *
 * # What's under test
 *
 * `callNeuron()` is the wrapper that registers in-flight LLM calls with the
 * RunControlRegistry so external interrupt can cancel them sub-second.
 * These tests exercise the registration / unregistration / cancellation
 * lifecycle without spinning up a real LLM.
 *
 * We use a mock model with `invoke()` and `stream()` methods that just
 * resolve / iterate based on the AbortSignal, so we can reliably observe:
 *   - the call was added to `runCtx.neuronCalls` while in flight
 *   - the call was removed on completion (success / error / abort)
 *   - cancellation reaches the call's controller signal
 *   - `runControlRegistry.cancel(runId)` cancels in-flight calls
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import { NeuronRegistry, type CallNeuronOptions } from '../../src/lib/neurons/NeuronRegistry';

// We don't need a real DB connection for these tests — `callNeuron` accepts
// a `modelOverride` so we can bypass `getModel()` (which would otherwise hit
// MongoDB / the LLM provider).
function buildRegistry(): NeuronRegistry {
  return new NeuronRegistry({
    databaseUrl: 'mongodb://localhost:27017/test-noop',
  });
}

interface MockModel {
  invoke: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
}

function buildMockModel(): MockModel {
  // invoke() resolves immediately by default; tests override per-case.
  // stream() returns an async iterable that yields a chunk every 5ms until
  // the signal aborts (or 100 iterations) — this lets us observe in-flight
  // cancellation without waiting forever.
  return {
    invoke: vi.fn(),
    stream: vi.fn(),
  };
}

describe('callNeuron — registration with RunControlRegistry', () => {
  beforeEach(() => {
    // Tear down any leftover contexts so tests are isolated.
    runControlRegistry.runIds().forEach((id) => runControlRegistry.unregister(id));
  });

  it('registers the call on the run context for the duration of invoke()', async () => {
    const registry = buildRegistry();
    const model = buildMockModel();
    const runId = 'r-invoke-1';
    const ctx = runControlRegistry.register(runId, 'worker-test');

    // Promise we control — resolves when we say so. Lets us observe the
    // mid-flight state of the registry.
    let resolveInvoke!: (value: any) => void;
    model.invoke.mockReturnValue(new Promise((r) => { resolveInvoke = r; }));

    // Start the call (don't await yet)
    const callPromise = registry.callNeuron('test-neuron', 'user-1', [], {
      runId,
      modelOverride: model as any,
    } as CallNeuronOptions);

    // Give the registration a microtick.
    await Promise.resolve();
    expect(ctx.neuronCalls.size).toBe(1);

    // Resolve the model and wait for the wrapper.
    resolveInvoke({ content: 'ok' });
    await callPromise;

    // After completion the call is unregistered.
    expect(ctx.neuronCalls.size).toBe(0);
  });

  it('unregisters the call on invoke() error', async () => {
    const registry = buildRegistry();
    const model = buildMockModel();
    const runId = 'r-invoke-err';
    const ctx = runControlRegistry.register(runId, 'worker-test');

    model.invoke.mockRejectedValue(new Error('boom'));

    await expect(
      registry.callNeuron('test-neuron', 'user-1', [], {
        runId,
        modelOverride: model as any,
      } as CallNeuronOptions),
    ).rejects.toThrow('boom');

    expect(ctx.neuronCalls.size).toBe(0);
  });

  it('cancel(runId) aborts an in-flight invoke()', async () => {
    const registry = buildRegistry();
    const model = buildMockModel();
    const runId = 'r-invoke-cancel';
    const ctx = runControlRegistry.register(runId, 'worker-test');

    let captured: AbortSignal | undefined;
    let rejectInvoke!: (err: any) => void;
    model.invoke.mockImplementation(async (_msgs: any, opts: any) => {
      captured = opts?.signal;
      return new Promise((_, reject) => {
        rejectInvoke = reject;
        captured?.addEventListener('abort', () => {
          const err: Error & { name: string } = new Error('AbortError');
          err.name = 'AbortError';
          rejectInvoke(err);
        }, { once: true });
      });
    });

    const callPromise = registry.callNeuron('test-neuron', 'user-1', [], {
      runId,
      modelOverride: model as any,
    } as CallNeuronOptions);

    // Wait for the call to land in the registry
    await Promise.resolve();
    expect(ctx.neuronCalls.size).toBe(1);
    expect(captured?.aborted).toBe(false);

    // Trigger cancel — this should abort the captured signal.
    runControlRegistry.cancel(runId, 'test-cancel');

    // The captured signal is what model.invoke saw.
    expect(captured?.aborted).toBe(true);

    await expect(callPromise).rejects.toThrow();
    expect(ctx.neuronCalls.size).toBe(0);
  });

  it('explicit signal aborts cooperatively without registry involvement', async () => {
    const registry = buildRegistry();
    const model = buildMockModel();

    let captured: AbortSignal | undefined;
    model.invoke.mockImplementation(async (_msgs: any, opts: any) => {
      captured = opts?.signal;
      return new Promise((_, reject) => {
        captured?.addEventListener('abort', () => {
          const err: Error & { name: string } = new Error('AbortError');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
    });

    const externalController = new AbortController();
    const callPromise = registry.callNeuron('test-neuron', 'user-1', [], {
      // No runId — purely external signal
      signal: externalController.signal,
      modelOverride: model as any,
    } as CallNeuronOptions);

    await Promise.resolve();
    expect(captured?.aborted).toBe(false);

    externalController.abort();
    expect(captured?.aborted).toBe(true);
    await expect(callPromise).rejects.toThrow();
  });

  it('pre-aborted explicit signal short-circuits to immediate cancel', async () => {
    const registry = buildRegistry();
    const model = buildMockModel();

    let captured: AbortSignal | undefined;
    model.invoke.mockImplementation(async (_msgs: any, opts: any) => {
      captured = opts?.signal;
      // Don't reject — just resolve so we can observe state.
      return { content: 'whatever' };
    });

    const externalController = new AbortController();
    externalController.abort('pre-abort');

    await registry.callNeuron('test-neuron', 'user-1', [], {
      signal: externalController.signal,
      modelOverride: model as any,
    } as CallNeuronOptions);

    expect(captured?.aborted).toBe(true);
  });

  it('streaming path: registration + cleanup on iteration completion', async () => {
    const registry = buildRegistry();
    const model = buildMockModel();
    const runId = 'r-stream-ok';
    const ctx = runControlRegistry.register(runId, 'worker-test');

    // Mock stream that yields 3 chunks then ends.
    model.stream.mockImplementation(async function* () {
      yield { content: 'a' };
      yield { content: 'b' };
      yield { content: 'c' };
    });

    const result = await registry.callNeuron('test-neuron', 'user-1', [], {
      runId,
      stream: true,
      modelOverride: model as any,
    } as CallNeuronOptions);

    // Pre-iteration: the call IS registered (cleanup happens on iterate).
    expect(ctx.neuronCalls.size).toBe(1);

    const chunks: any[] = [];
    for await (const chunk of result as AsyncIterable<unknown>) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    // Post-iteration: cleanup ran, call unregistered.
    expect(ctx.neuronCalls.size).toBe(0);
  });

  it('streaming path: cancel during iteration aborts the call', async () => {
    const registry = buildRegistry();
    const model = buildMockModel();
    const runId = 'r-stream-cancel';
    const ctx = runControlRegistry.register(runId, 'worker-test');

    let capturedSignal: AbortSignal | undefined;
    // Stream that emits chunks every 10ms and respects the signal.
    model.stream.mockImplementation(async function* (_msgs: any, opts: any) {
      capturedSignal = opts?.signal;
      for (let i = 0; i < 100; i++) {
        if (capturedSignal?.aborted) {
          const err: Error & { name: string } = new Error('AbortError');
          err.name = 'AbortError';
          throw err;
        }
        yield { content: `chunk-${i}` };
        await new Promise((r) => setTimeout(r, 5));
      }
    });

    const stream = (await registry.callNeuron('test-neuron', 'user-1', [], {
      runId,
      stream: true,
      modelOverride: model as any,
    } as CallNeuronOptions)) as AsyncIterable<any>;

    // Consume a couple of chunks then cancel.
    const iter = stream[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(ctx.neuronCalls.size).toBe(1);

    runControlRegistry.cancel(runId, 'mid-stream');
    expect(capturedSignal?.aborted).toBe(true);

    // The next iteration should throw.
    await expect(iter.next()).rejects.toThrow();
    expect(ctx.neuronCalls.size).toBe(0);
  });

  it('streaming path: cleanup also fires when the iterator is .return()d early', async () => {
    const registry = buildRegistry();
    const model = buildMockModel();
    const runId = 'r-stream-early-return';
    const ctx = runControlRegistry.register(runId, 'worker-test');

    model.stream.mockImplementation(async function* () {
      yield { content: 'a' };
      yield { content: 'b' };
      yield { content: 'c' };
    });

    const stream = (await registry.callNeuron('test-neuron', 'user-1', [], {
      runId,
      stream: true,
      modelOverride: model as any,
    } as CallNeuronOptions)) as AsyncIterable<any>;

    const iter = stream[Symbol.asyncIterator]();
    await iter.next(); // consume one chunk
    expect(ctx.neuronCalls.size).toBe(1);
    if (iter.return) {
      await iter.return();
    }
    expect(ctx.neuronCalls.size).toBe(0);
  });
});
