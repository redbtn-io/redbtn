/**
 * Vitest for native tool: glob (Env Phase C — fs pack)
 *
 * Verifies:
 *   - bash globstar+dotglob+nullglob script construction
 *   - paths-array parsing
 *   - safe-pattern allowlist rejection
 *   - basePath propagation as cwd
 *   - hard cap at MAX_RESULTS
 *   - validation + error surface
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';
import { buildEnv } from '../environments/_helpers';

vi.mock('../../src/lib/environments/loadAndResolveEnvironment', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/loadAndResolveEnvironment')>(
    '../../src/lib/environments/loadAndResolveEnvironment',
  );
  return { ...actual, loadAndResolveEnvironment: vi.fn() };
});

import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import globTool from '../../src/lib/tools/native/glob';

interface FakeSession {
  exec: ReturnType<typeof vi.fn>;
}

function makeContext(userId: string): NativeToolContext {
  return {
    publisher: null,
    state: { userId },
    runId: 'r',
    nodeId: 'n',
    toolId: 't',
    abortSignal: null,
  };
}

function fakeAcquire(session: FakeSession) {
  vi.spyOn(environmentManager, 'acquire').mockResolvedValue(session as unknown as Awaited<ReturnType<typeof environmentManager.acquire>>);
}

function execOk(stdout: string, exitCode = 0) {
  return vi.fn().mockResolvedValue({ stdout, stderr: '', exitCode, durationMs: 1, truncated: false });
}

beforeEach(() => {
  environmentManager.__reset();
  vi.mocked(loadAndResolveEnvironment).mockResolvedValue({
    env: buildEnv({ environmentId: 'env_test', userId: 'user_a' }),
    sshKey: 'k',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('glob — schema', () => {
  test('requires environmentId + pattern', () => {
    expect(globTool.inputSchema.required).toEqual(['environmentId', 'pattern']);
    expect(globTool.server).toBe('fs');
  });
});

describe('glob — validation', () => {
  test('missing pattern → VALIDATION', async () => {
    const r = await globTool.handler({ environmentId: 'env_test' }, makeContext('user_a'));
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('pattern with backticks → rejected by safe-pattern allowlist', async () => {
    const r = await globTool.handler(
      { environmentId: 'env_test', pattern: '`rm -rf /`' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('pattern with $ → rejected', async () => {
    const r = await globTool.handler(
      { environmentId: 'env_test', pattern: '$(whoami).txt' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('pattern with newline → rejected', async () => {
    const r = await globTool.handler(
      { environmentId: 'env_test', pattern: 'a\nb' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('overly long pattern → VALIDATION', async () => {
    const r = await globTool.handler(
      { environmentId: 'env_test', pattern: 'a'.repeat(513) },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('glob — happy path', () => {
  test('parses stdout into a paths array', async () => {
    const exec = execOk('src/foo.ts\nsrc/bar.ts\nsrc/baz.ts\n');
    fakeAcquire({ exec });
    const r = await globTool.handler(
      { environmentId: 'env_test', pattern: 'src/*.ts' },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.paths).toEqual(['src/foo.ts', 'src/bar.ts', 'src/baz.ts']);
    expect(body.total).toBe(3);
    expect(body.truncated).toBe(false);
  });

  test('command embeds pattern with globstar/dotglob/nullglob shopt', async () => {
    const exec = execOk('');
    fakeAcquire({ exec });
    await globTool.handler(
      { environmentId: 'env_test', pattern: 'src/**/*.ts' },
      makeContext('user_a'),
    );
    const sentCmd = exec.mock.calls[0][0] as string;
    expect(sentCmd).toContain('shopt -s globstar dotglob nullglob');
    expect(sentCmd).toContain('src/**/*.ts');
    expect(sentCmd).toContain('printf');
  });

  test('basePath flows through as exec cwd', async () => {
    const exec = execOk('a.txt\n');
    fakeAcquire({ exec });
    await globTool.handler(
      { environmentId: 'env_test', pattern: '*.txt', basePath: '/etc' },
      makeContext('user_a'),
    );
    const opts = exec.mock.calls[0][1];
    expect(opts).toEqual({ cwd: '/etc' });
  });

  test('empty stdout → empty paths array (nullglob behaviour)', async () => {
    const exec = execOk('');
    fakeAcquire({ exec });
    const r = await globTool.handler(
      { environmentId: 'env_test', pattern: 'no/such/*.x' },
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.paths).toEqual([]);
    expect(body.total).toBe(0);
  });

  test('caps at MAX_RESULTS and reports truncated', async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `f${i}.txt`).join('\n');
    fakeAcquire({ exec: execOk(lines) });
    const r = await globTool.handler(
      { environmentId: 'env_test', pattern: '*.txt' },
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.total).toBe(1000);
    expect(body.totalRaw).toBe(1500);
    expect(body.truncated).toBe(true);
  });
});

describe('glob — error surfaces', () => {
  test('non-zero exit → GLOB_FAILED', async () => {
    fakeAcquire({ exec: execOk('', 2) });
    const r = await globTool.handler(
      { environmentId: 'env_test', pattern: '*.x' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('GLOB_FAILED');
  });

  test('exec promise rejection → GLOB_FAILED', async () => {
    fakeAcquire({ exec: vi.fn().mockRejectedValue(new Error('drop')) });
    const r = await globTool.handler(
      { environmentId: 'env_test', pattern: '*.x' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('GLOB_FAILED');
  });
});
