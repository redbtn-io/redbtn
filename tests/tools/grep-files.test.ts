/**
 * Vitest for native tool: grep_files (Env Phase C — fs pack)
 *
 * Verifies:
 *   - rg-vs-grep probe + branch (probe is the first exec call)
 *   - grep -rn fallback parsing of `<file>:<line>:<content>`
 *   - rg JSON parsing of line-delimited match events
 *   - context-lines flag handling
 *   - maxResults capping
 *   - exit codes 0 (matches) and 1 (no matches) both treated as non-error
 *   - validation errors
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
import grepFilesTool from '../../src/lib/tools/native/grep-files';

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

function execResult(stdout: string, exitCode = 0, stderr = '') {
  return { stdout, stderr, exitCode, durationMs: 1, truncated: false };
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

describe('grep_files — schema', () => {
  test('requires envId + pattern', () => {
    expect(grepFilesTool.inputSchema.required).toEqual(['environmentId', 'pattern']);
    expect(grepFilesTool.server).toBe('fs');
  });
});

describe('grep_files — validation', () => {
  test('missing pattern → VALIDATION', async () => {
    const r = await grepFilesTool.handler({ environmentId: 'env_test' }, makeContext('user_a'));
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('contextLines out of range → VALIDATION', async () => {
    const r = await grepFilesTool.handler(
      { environmentId: 'env_test', pattern: 'x', contextLines: 100 },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('maxResults > 1000 → VALIDATION', async () => {
    const r = await grepFilesTool.handler(
      { environmentId: 'env_test', pattern: 'x', maxResults: 5000 },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('grep_files — grep fallback', () => {
  test('parses grep output', async () => {
    const exec = vi.fn()
      // probe (rg) → not found
      .mockResolvedValueOnce(execResult('', 1))
      // grep run
      .mockResolvedValueOnce(execResult(
        'src/a.ts:10:const x = 1;\nsrc/b.ts:42:function foo() {}\n',
      ));
    fakeAcquire({ exec });
    const r = await grepFilesTool.handler(
      { environmentId: 'env_test', pattern: 'foo' },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.engine).toBe('grep');
    expect(body.matches.length).toBe(2);
    expect(body.matches[0]).toEqual({ file: 'src/a.ts', line: 10, content: 'const x = 1;' });
    expect(body.matches[1]).toEqual({ file: 'src/b.ts', line: 42, content: 'function foo() {}' });
  });

  test('exit code 1 (no matches) → empty matches array, not an error', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce(execResult('', 1)) // probe miss
      .mockResolvedValueOnce(execResult('', 1)); // grep no matches
    fakeAcquire({ exec });
    const r = await grepFilesTool.handler(
      { environmentId: 'env_test', pattern: 'nope' },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text).matches).toEqual([]);
  });

  test('exit code ≥2 → GREP_FAILED', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce(execResult('', 1))
      .mockResolvedValueOnce(execResult('', 2, 'permission denied'));
    fakeAcquire({ exec });
    const r = await grepFilesTool.handler(
      { environmentId: 'env_test', pattern: 'x' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('GREP_FAILED');
  });

  test('contextLines adds -A/-B flags to grep command', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce(execResult('', 1)) // probe miss
      .mockResolvedValueOnce(execResult('', 1));
    fakeAcquire({ exec });
    await grepFilesTool.handler(
      { environmentId: 'env_test', pattern: 'x', contextLines: 3 },
      makeContext('user_a'),
    );
    // The 2nd call (after probe) is the actual grep
    const grepCmd = exec.mock.calls[1][0] as string;
    expect(grepCmd).toContain('-A 3');
    expect(grepCmd).toContain('-B 3');
  });

  test('parses context lines (dash separator)', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce(execResult('', 1)) // probe miss
      .mockResolvedValueOnce(execResult(
        'src/a.ts-9-// before\nsrc/a.ts:10:MATCH HERE\nsrc/a.ts-11-// after\n',
      ));
    fakeAcquire({ exec });
    const r = await grepFilesTool.handler(
      { environmentId: 'env_test', pattern: 'MATCH', contextLines: 1 },
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.matches.length).toBe(1);
    expect(body.matches[0].file).toBe('src/a.ts');
    expect(body.matches[0].line).toBe(10);
    expect(body.matches[0].context).toContain('// before');
    expect(body.matches[0].context).toContain('// after');
  });
});

describe('grep_files — rg fast path', () => {
  test('uses rg when probe succeeds + parses JSON match events', async () => {
    const rgJson = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 'src/a.ts' }, line_number: 7, lines: { text: 'TODO: fix\n' } } }),
      JSON.stringify({ type: 'end', data: { path: { text: 'src/a.ts' } } }),
    ].join('\n');
    const exec = vi.fn()
      // rg probe found
      .mockResolvedValueOnce(execResult('/usr/bin/rg\n', 0))
      // rg run
      .mockResolvedValueOnce(execResult(rgJson));
    fakeAcquire({ exec });
    const r = await grepFilesTool.handler(
      { environmentId: 'env_test', pattern: 'TODO' },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.engine).toBe('rg');
    expect(body.matches.length).toBe(1);
    expect(body.matches[0]).toEqual({ file: 'src/a.ts', line: 7, content: 'TODO: fix' });
  });

  test('caps at maxResults during rg parse', async () => {
    const events: string[] = [JSON.stringify({ type: 'begin', data: { path: { text: 'a.ts' } } })];
    for (let i = 0; i < 200; i += 1) {
      events.push(JSON.stringify({
        type: 'match',
        data: { path: { text: 'a.ts' }, line_number: i + 1, lines: { text: `m${i}\n` } },
      }));
    }
    const exec = vi.fn()
      .mockResolvedValueOnce(execResult('/usr/bin/rg', 0))
      .mockResolvedValueOnce(execResult(events.join('\n')));
    fakeAcquire({ exec });
    const r = await grepFilesTool.handler(
      { environmentId: 'env_test', pattern: 'm', maxResults: 50 },
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.matches.length).toBe(50);
    expect(body.truncated).toBe(true);
  });
});
