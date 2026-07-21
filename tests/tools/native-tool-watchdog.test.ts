import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from '../../src/lib/nodes/universal/executors/toolExecutor';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import { ToolHangError } from '../../src/lib/tools/tool-idle-watchdog';
import createStateRecord from '../../src/lib/tools/native/create-state-record';

function registerNativeTool(name: string, handler: any) {
  getNativeRegistry().register(name, {
    description: name,
    inputSchema: { type: 'object' },
    handler,
  });
}

function makeRunPublisher() {
  return {
    toolStart: vi.fn(async () => {}),
    toolProgress: vi.fn(async () => {}),
    toolComplete: vi.fn(async () => {}),
    toolError: vi.fn(async () => {}),
    chunk: vi.fn(async () => {}),
    thinkingChunk: vi.fn(async () => {}),
  };
}

describe('native tool idle watchdog integration', () => {
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

  it('allows successful native tools to complete', async () => {
    const toolName = `test_native_success_${Date.now()}`;
    registerNativeTool(toolName, async () => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    }));

    await expect(
      executeTool(
        {
          toolName,
          parameters: {},
          outputField: 'result',
          idleTimeoutMs: 100,
        },
        { runId: 'run-success' },
      ),
    ).resolves.toEqual({ result: { ok: true } });
  });

  it('fails a create_state_record validation envelope instead of completing the graph step', async () => {
    const runPublisher = makeRunPublisher();
    // Built-in registration uses production's compiled `.js` modules. Register
    // the source definition explicitly so this source-level Vitest test drives
    // the real State Records validation handler too.
    getNativeRegistry().register('create_state_record', createStateRecord);

    await expect(
      executeTool(
        {
          toolName: 'create_state_record',
          parameters: {},
          outputField: 'result',
        },
        { runId: 'run-state-record-validation', runPublisher },
      ),
    ).rejects.toThrow(/Native tool "create_state_record" returned error: namespace is required/);

    expect(runPublisher.toolComplete).not.toHaveBeenCalled();
    expect(runPublisher.toolError).toHaveBeenCalledTimes(1);
    expect(runPublisher.toolError).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('namespace is required'),
    );
  });

  it('fails when a native tool returns a malformed non-error result', async () => {
    const toolName = `test_native_malformed_${Date.now()}`;
    const runPublisher = makeRunPublisher();
    registerNativeTool(toolName, async () => ({ content: 'not-an-array' } as any));

    await expect(
      executeTool(
        {
          toolName,
          parameters: {},
          outputField: 'result',
          errorHandling: {
            onError: 'fallback',
            fallbackValue: { fallback: true },
          },
        },
        { runId: 'run-native-malformed', runPublisher },
      ),
    ).resolves.toEqual({ fallback: true });

    expect(runPublisher.toolComplete).not.toHaveBeenCalled();
    expect(runPublisher.toolError).toHaveBeenCalledTimes(1);
    expect(runPublisher.toolError).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('malformed result'),
    );
  });

  it('retries native isError envelopes and only completes after a successful retry', async () => {
    const toolName = `test_native_error_retry_${Date.now()}`;
    const runPublisher = makeRunPublisher();
    const handler = vi.fn(async () => {
      if (handler.mock.calls.length === 1) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: { message: 'try again' } }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    });
    registerNativeTool(toolName, handler);

    const result = executeTool(
      {
        toolName,
        parameters: {},
        outputField: 'result',
        retryOnError: true,
        maxRetries: 1,
      },
      { runId: 'run-native-error-retry', runPublisher },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({ result: { ok: true } });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(runPublisher.toolProgress).toHaveBeenCalledWith(
      expect.any(String),
      'retry_1',
      expect.objectContaining({ data: { attempt: 1, maxRetries: 1 } }),
    );
    expect(runPublisher.toolComplete).toHaveBeenCalledTimes(1);
    expect(runPublisher.toolError).not.toHaveBeenCalled();
  });

  it('lets errorHandling recover from a native isError envelope', async () => {
    const toolName = `test_native_error_fallback_${Date.now()}`;
    const runPublisher = makeRunPublisher();
    registerNativeTool(toolName, async () => ({
      content: [{ type: 'text', text: JSON.stringify({ error: { message: 'denied' } }) }],
      isError: true,
    }));

    await expect(
      executeTool(
        {
          toolName,
          parameters: {},
          outputField: 'result',
          errorHandling: {
            onError: 'fallback',
            fallbackValue: { recovered: true },
          },
        },
        { runId: 'run-native-error-fallback', runPublisher },
      ),
    ).resolves.toEqual({ recovered: true });

    expect(runPublisher.toolComplete).not.toHaveBeenCalled();
    expect(runPublisher.toolError).toHaveBeenCalledTimes(1);
  });

  it('aborts and rejects a silent native tool as ToolHangError after the idle window', async () => {
    const toolName = `test_native_hang_${Date.now()}`;
    let observedSignal: AbortSignal | null = null;
    registerNativeTool(toolName, async (_args: any, context: any) => {
      observedSignal = context.abortSignal;
      return new Promise(() => {});
    });

    const promise = executeTool(
      {
        toolName,
        parameters: {},
        outputField: 'result',
        idleTimeoutMs: 100,
      },
      { runId: 'run-hang' },
    );
    const rejection = expect(promise).rejects.toBeInstanceOf(ToolHangError);

    await vi.advanceTimersByTimeAsync(99);
    expect(observedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBeInstanceOf(ToolHangError);
  });

  it('does not cut off native tools that emit progress before each idle window expires', async () => {
    const toolName = `test_native_streaming_${Date.now()}`;
    const runPublisher = makeRunPublisher();
    registerNativeTool(toolName, async (_args: any, context: any) =>
      new Promise((resolve) => {
        let count = 0;
        const tick = () => {
          count += 1;
          void context.publisher.toolProgress(context.toolId, `chunk_${count}`);
          if (count >= 5) {
            resolve({ content: [{ type: 'text', text: JSON.stringify({ count }) }] });
            return;
          }
          setTimeout(tick, 90);
        };
        setTimeout(tick, 90);
      }),
    );

    const promise = executeTool(
      {
        toolName,
        parameters: {},
        outputField: 'result',
        idleTimeoutMs: 100,
      },
      { runId: 'run-streaming', runPublisher },
    );

    await vi.advanceTimersByTimeAsync(450);
    await expect(promise).resolves.toEqual({ result: { count: 5 } });
    expect(runPublisher.toolProgress).toHaveBeenCalledTimes(5);
    expect(runPublisher.toolError).not.toHaveBeenCalled();
  });

  it('does not cut off native tools that emit output chunks before each idle window expires', async () => {
    const toolName = `test_native_output_${Date.now()}`;
    let observedSignal: AbortSignal | null = null;
    registerNativeTool(toolName, async (_args: any, context: any) =>
      new Promise((resolve) => {
        observedSignal = context.abortSignal;
        let count = 0;
        const tick = () => {
          count += 1;
          context.onChunk(`chunk-${count}`, 'stdout');
          if (count >= 5) {
            resolve({ content: [{ type: 'text', text: JSON.stringify({ count }) }] });
            return;
          }
          setTimeout(tick, 90);
        };
        setTimeout(tick, 90);
      }),
    );

    const promise = executeTool(
      {
        toolName,
        parameters: {},
        outputField: 'result',
        idleTimeoutMs: 100,
      },
      { runId: 'run-output' },
    );

    await vi.advanceTimersByTimeAsync(450);
    await expect(promise).resolves.toEqual({ result: { count: 5 } });
    expect(observedSignal?.aborted).toBe(false);
  });

  it('lets step errorHandling catch ToolHangError and return fallback', async () => {
    const toolName = `test_native_fallback_${Date.now()}`;
    registerNativeTool(toolName, async () => new Promise(() => {}));

    const promise = executeTool(
      {
        toolName,
        parameters: {},
        outputField: 'result',
        idleTimeoutMs: 100,
        errorHandling: {
          onError: 'fallback',
          fallbackValue: { fallback: true },
        },
      },
      { runId: 'run-fallback' },
    );

    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toEqual({ fallback: true });
  });
});
