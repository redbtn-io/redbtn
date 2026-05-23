import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ToolHangError,
  withToolIdleWatchdog,
  type ToolIdleWatchdogHandle,
} from '../../src/lib/tools/tool-idle-watchdog';

describe('withToolIdleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects with ToolHangError and aborts the supplied controller after idle timeout', async () => {
    const abortController = new AbortController();
    let settled = false;

    const promise = withToolIdleWatchdog(
      () => new Promise<never>(() => {}),
      { idleTimeoutMs: 100, toolName: 'ssh_shell', abortController },
    );
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejection = expect(promise).rejects.toBeInstanceOf(ToolHangError);

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    expect(abortController.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBeInstanceOf(ToolHangError);
    expect((abortController.signal.reason as ToolHangError).toolName).toBe('ssh_shell');
  });

  it('resets the idle timer when progress is marked', async () => {
    const abortController = new AbortController();
    let watchdogHandle: ToolIdleWatchdogHandle | null = null;
    let resolveOperation: ((value: string) => void) | null = null;

    const promise = withToolIdleWatchdog(
      (watchdog) => {
        watchdogHandle = watchdog;
        return new Promise<string>((resolve) => {
          resolveOperation = resolve;
        });
      },
      { idleTimeoutMs: 100, toolName: 'streaming-tool', abortController },
    );

    await vi.advanceTimersByTimeAsync(80);
    watchdogHandle!.markProgress();
    await vi.advanceTimersByTimeAsync(80);
    expect(abortController.signal.aborted).toBe(false);

    watchdogHandle!.markProgress();
    await vi.advanceTimersByTimeAsync(99);
    expect(abortController.signal.aborted).toBe(false);

    resolveOperation!('ok');
    await expect(promise).resolves.toBe('ok');

    await vi.advanceTimersByTimeAsync(500);
    expect(abortController.signal.aborted).toBe(false);
  });

  it('can run indefinitely while progress arrives before each idle window expires', async () => {
    const abortController = new AbortController();
    let watchdogHandle: ToolIdleWatchdogHandle | null = null;
    let resolveOperation: ((value: string) => void) | null = null;

    const promise = withToolIdleWatchdog(
      (watchdog) => {
        watchdogHandle = watchdog;
        return new Promise<string>((resolve) => {
          resolveOperation = resolve;
        });
      },
      { idleTimeoutMs: 100, toolName: 'long-streaming-tool', abortController },
    );

    for (let i = 0; i < 25; i += 1) {
      await vi.advanceTimersByTimeAsync(90);
      watchdogHandle!.markProgress();
      expect(abortController.signal.aborted).toBe(false);
    }

    resolveOperation!('done');
    await expect(promise).resolves.toBe('done');
    expect(abortController.signal.aborted).toBe(false);
  });
});
