import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from '../../src/lib/nodes/universal/executors/toolExecutor';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import { ToolHangError } from '../../src/lib/tools/tool-idle-watchdog';

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
