import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

vi.mock('../../src/lib/environments/loadAndResolveEnvironment', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/loadAndResolveEnvironment')>(
    '../../src/lib/environments/loadAndResolveEnvironment',
  );
  return { ...actual, loadAndResolveEnvironment: vi.fn() };
});

vi.mock('../../src/lib/environments/EnvironmentManager', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/EnvironmentManager')>(
    '../../src/lib/environments/EnvironmentManager',
  );
  return { ...actual, environmentManager: { acquire: vi.fn() } };
});

import runCommandTool from '../../src/lib/tools/native/run-command';
import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';

const FAKE_ENV = {
  environmentId: 'env_rc',
  userId: 'user-1',
  name: 'rc env',
  kind: 'desktop-agent' as const,
  host: '127.0.0.1',
  port: 22,
  user: 'tester',
  secretRef: 'KEY',
  workingDir: '/tmp',
  idleTimeoutMs: 5000,
  maxLifetimeMs: 60000,
  reconnect: { maxAttempts: 3, backoffMs: 50, maxBackoffMs: 500 },
  archiveOutputLogs: false,
  isPublic: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1', data: { environmentId: 'env_rc' } },
    runId: 'test-run-interrupt',
    nodeId: 'test-node',
    toolId: 'test-tool',
    abortSignal: null,
    ...overrides,
  } as NativeToolContext;
}

describe('run_command — interrupt & kill-on-cancel', () => {
  beforeEach(() => {
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({
      env: FAKE_ENV,
      sshKey: 'fake-key',
    });
  });

  test('registers onCancel with runControlRegistry and aborts session.exec when cancelled', async () => {
    runControlRegistry.register('test-run-interrupt', 'worker-1');

    let receivedAbortSignal: AbortSignal | undefined;
    const exec = vi.fn(async (_cmd: string, opts: any) => {
      receivedAbortSignal = opts.abortSignal;
      // Simulate waiting for command
      return new Promise<any>((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () => {
          const err = new Error('Command killed by interrupt');
          (err as any).code = 'command_cancelled';
          reject(err);
        });
      });
    });

    vi.mocked(environmentManager.acquire).mockResolvedValue({ exec } as any);

    const callPromise = runCommandTool.handler(
      { command: 'sleep 300' },
      makeMockContext({ runId: 'test-run-interrupt' }),
    );

    // Give a tick to enter session.exec
    await new Promise((r) => setTimeout(r, 10));
    expect(receivedAbortSignal).toBeDefined();
    expect(receivedAbortSignal?.aborted).toBe(false);

    // Cancel the run via registry
    runControlRegistry.cancel('test-run-interrupt', 'user cancelled');

    const result = await callPromise;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.exitCode).toBe(130);
    expect(parsed.code).toBe('KILLED_BY_INTERRUPT');
    expect(parsed.error).toBe('Command killed by interrupt');

    runControlRegistry.unregister('test-run-interrupt');
  });

  test('returns exitCode 130 and KILLED_BY_INTERRUPT when context.abortSignal fires', async () => {
    const ac = new AbortController();
    const exec = vi.fn(async (_cmd: string, opts: any) => {
      return new Promise<any>((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () => {
          const err = new Error('exec aborted');
          reject(err);
        });
      });
    });

    vi.mocked(environmentManager.acquire).mockResolvedValue({ exec } as any);

    const callPromise = runCommandTool.handler(
      { command: 'sleep 300' },
      makeMockContext({ abortSignal: ac.signal }),
    );

    await new Promise((r) => setTimeout(r, 10));
    ac.abort();

    const result = await callPromise;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.exitCode).toBe(130);
    expect(parsed.code).toBe('KILLED_BY_INTERRUPT');
    expect(parsed.error).toBe('Command killed by interrupt');
  });
});
