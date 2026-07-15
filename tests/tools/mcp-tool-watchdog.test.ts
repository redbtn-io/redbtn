import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from '../../src/lib/nodes/universal/executors/toolExecutor';
import { ToolHangError } from '../../src/lib/tools/tool-idle-watchdog';

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

describe('MCP tool idle watchdog integration', () => {
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

  it('allows successful MCP tools to complete', async () => {
    const mcpClient = {
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      })),
    };

    await expect(
      executeTool(
        {
          toolName: `test_mcp_success_${Date.now()}`,
          parameters: {},
          outputField: 'result',
          idleTimeoutMs: 100,
        },
        { runId: 'run-mcp-success', mcpClient },
      ),
    ).resolves.toEqual({ result: { ok: true } });
  });

  it.each([
    ['a string JSON error', JSON.stringify({ error: 'denied' }), 'denied'],
    ['a structured JSON error', JSON.stringify({ error: { message: 'denied', code: 'DENIED' } }), '"message":"denied"'],
    ['a non-JSON text error', 'gateway denied the request', 'gateway denied the request'],
    ['an envelope with no text detail', undefined, '"isError":true'],
  ])('fails %s without formatter errors', async (_label, text, expectedDetail) => {
    const mcpClient = {
      callTool: vi.fn(async () => ({
        content: text === undefined ? [] : [{ type: 'text', text }],
        isError: true,
      })),
    };

    await expect(
      executeTool(
        {
          toolName: `test_mcp_error_${Date.now()}`,
          parameters: {},
          outputField: 'result',
        },
        { runId: 'run-mcp-error', mcpClient },
      ),
    ).rejects.toThrow(expectedDetail);
  });

  it('aborts and rejects a silent MCP tool as ToolHangError after the idle window', async () => {
    let observedSignal: AbortSignal | null = null;
    const mcpClient = {
      callTool: vi.fn((_toolName, _args, _meta, signal: AbortSignal) => {
        observedSignal = signal;
        return new Promise(() => {});
      }),
    };

    const promise = executeTool(
      {
        toolName: `test_mcp_hang_${Date.now()}`,
        parameters: {},
        outputField: 'result',
        idleTimeoutMs: 100,
      },
      { runId: 'run-mcp-hang', mcpClient },
    );
    const rejection = expect(promise).rejects.toBeInstanceOf(ToolHangError);

    await vi.advanceTimersByTimeAsync(99);
    expect(observedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBeInstanceOf(ToolHangError);
  });

  it('does not cut off MCP tools that report progress before each idle window expires', async () => {
    const runPublisher = makeRunPublisher();
    let observedMeta: Record<string, any> | null = null;
    const mcpClient = {
      callTool: vi.fn((_toolName, _args, meta) =>
        new Promise((resolve) => {
          observedMeta = meta;
          let count = 0;
          const tick = () => {
            count += 1;
            void meta.publisher.toolProgress(meta.toolId, `chunk_${count}`);
            if (count >= 5) {
              resolve({ content: [{ type: 'text', text: JSON.stringify({ count }) }] });
              return;
            }
            setTimeout(tick, 90);
          };
          setTimeout(tick, 90);
        }),
      ),
    };

    const promise = executeTool(
      {
        toolName: `test_mcp_progress_${Date.now()}`,
        parameters: {},
        outputField: 'result',
        idleTimeoutMs: 100,
      },
      { runId: 'run-mcp-progress', mcpClient, runPublisher },
    );

    await vi.advanceTimersByTimeAsync(450);
    await expect(promise).resolves.toEqual({ result: { count: 5 } });
    expect(runPublisher.toolProgress).toHaveBeenCalledTimes(5);
    expect(runPublisher.toolError).not.toHaveBeenCalled();
    expect(Object.keys(observedMeta || {})).not.toContain('publisher');
    expect(Object.keys(observedMeta || {})).not.toContain('markProgress');
  });

  it('lets step errorHandling catch MCP ToolHangError and return fallback', async () => {
    const mcpClient = {
      callTool: vi.fn(() => new Promise(() => {})),
    };

    const promise = executeTool(
      {
        toolName: `test_mcp_fallback_${Date.now()}`,
        parameters: {},
        outputField: 'result',
        idleTimeoutMs: 100,
        errorHandling: {
          onError: 'fallback',
          fallbackValue: { fallback: true },
        },
      },
      { runId: 'run-mcp-fallback', mcpClient },
    );

    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toEqual({ fallback: true });
  });
});
