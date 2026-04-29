/**
 * Vitest for native tool: edit_file (Env Phase C — fs pack)
 *
 * The unique-match-or-reject semantics are the core contract of this tool
 * (matches Claude Code's Edit), so this test file leans heavily on the
 * count-and-branch behaviour:
 *
 *   - 0 matches             → NO_MATCH (file untouched)
 *   - 1 match               → success, replacements: 1
 *   - 2+ matches, replaceAll false → AMBIGUOUS_MATCH (file untouched)
 *   - 2+ matches, replaceAll true  → success, replacements: N
 *   - identical old/new strings    → VALIDATION (nothing to do)
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
import editFileTool from '../../src/lib/tools/native/edit-file';

interface FakeSession {
  sftpRead: ReturnType<typeof vi.fn>;
  sftpWrite: ReturnType<typeof vi.fn>;
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

describe('edit_file — schema', () => {
  test('requires environmentId, path, oldString, newString', () => {
    expect(editFileTool.inputSchema.required).toEqual(['environmentId', 'path', 'oldString', 'newString']);
    expect(editFileTool.server).toBe('fs');
  });
});

describe('edit_file — validation', () => {
  test('empty oldString → VALIDATION', async () => {
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: '', newString: 'b' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('identical old/new → VALIDATION', async () => {
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: 'same', newString: 'same' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('non-string newString → VALIDATION', async () => {
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: 'a', newString: 123 as unknown as string },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('edit_file — replaceAll: false (unique-match contract)', () => {
  test('zero matches → NO_MATCH and file is untouched', async () => {
    const sftpWrite = vi.fn();
    fakeAcquire({
      sftpRead: vi.fn().mockResolvedValue(Buffer.from('hello world', 'utf8')),
      sftpWrite,
    });
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: 'foo', newString: 'bar' },
      makeContext('user_a'),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('NO_MATCH');
    expect(sftpWrite).not.toHaveBeenCalled();
  });

  test('exactly one match → success, replacements: 1, file written', async () => {
    const sftpWrite = vi.fn().mockResolvedValue(undefined);
    fakeAcquire({
      sftpRead: vi.fn().mockResolvedValue(Buffer.from('hello world', 'utf8')),
      sftpWrite,
    });
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: 'world', newString: 'planet' },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.replacements).toBe(1);
    expect(sftpWrite).toHaveBeenCalledTimes(1);
    expect(sftpWrite.mock.calls[0][0]).toBe('/x');
    expect(sftpWrite.mock.calls[0][1]).toBe('hello planet');
  });

  test('two matches → AMBIGUOUS_MATCH and file is untouched', async () => {
    const sftpWrite = vi.fn();
    fakeAcquire({
      sftpRead: vi.fn().mockResolvedValue(Buffer.from('foo and foo and foo', 'utf8')),
      sftpWrite,
    });
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: 'foo', newString: 'bar' },
      makeContext('user_a'),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('AMBIGUOUS_MATCH');
    expect(body.matchCount).toBe(3);
    expect(sftpWrite).not.toHaveBeenCalled();
  });

  test('disambiguation by adding context produces a unique match', async () => {
    const sftpWrite = vi.fn().mockResolvedValue(undefined);
    fakeAcquire({
      sftpRead: vi.fn().mockResolvedValue(Buffer.from('a foo. b foo. c foo.', 'utf8')),
      sftpWrite,
    });
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: 'b foo', newString: 'b bar' },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    expect(sftpWrite.mock.calls[0][1]).toBe('a foo. b bar. c foo.');
  });

  test('newString containing $& is NOT treated as a regex backreference', async () => {
    const sftpWrite = vi.fn().mockResolvedValue(undefined);
    fakeAcquire({
      sftpRead: vi.fn().mockResolvedValue(Buffer.from('hello', 'utf8')),
      sftpWrite,
    });
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: 'hello', newString: '<$&>' },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    // String.prototype.replace would expand $& to the matched substring.
    // Our implementation uses indexOf+slice so it stays literal.
    expect(sftpWrite.mock.calls[0][1]).toBe('<$&>');
  });
});

describe('edit_file — replaceAll: true', () => {
  test('replaces every occurrence and returns count', async () => {
    const sftpWrite = vi.fn().mockResolvedValue(undefined);
    fakeAcquire({
      sftpRead: vi.fn().mockResolvedValue(Buffer.from('foo and foo and foo', 'utf8')),
      sftpWrite,
    });
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: 'foo', newString: 'bar', replaceAll: true },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.replacements).toBe(3);
    expect(sftpWrite.mock.calls[0][1]).toBe('bar and bar and bar');
  });

  test('zero matches with replaceAll → NO_MATCH (still rejected)', async () => {
    const sftpWrite = vi.fn();
    fakeAcquire({
      sftpRead: vi.fn().mockResolvedValue(Buffer.from('hello', 'utf8')),
      sftpWrite,
    });
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: 'foo', newString: 'bar', replaceAll: true },
      makeContext('user_a'),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('NO_MATCH');
    expect(sftpWrite).not.toHaveBeenCalled();
  });

  test('single match with replaceAll succeeds (count: 1)', async () => {
    const sftpWrite = vi.fn().mockResolvedValue(undefined);
    fakeAcquire({
      sftpRead: vi.fn().mockResolvedValue(Buffer.from('only one foo here', 'utf8')),
      sftpWrite,
    });
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: 'foo', newString: 'bar', replaceAll: true },
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.replacements).toBe(1);
    expect(sftpWrite.mock.calls[0][1]).toBe('only one bar here');
  });
});

describe('edit_file — error surfaces', () => {
  test('NOT_FOUND when SFTP read returns ENOENT', async () => {
    fakeAcquire({
      sftpRead: vi.fn().mockRejectedValue(new Error('ENOENT: /missing')),
      sftpWrite: vi.fn(),
    });
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/missing', oldString: 'a', newString: 'b' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('NOT_FOUND');
  });

  test('SFTP_WRITE_FAILED when write back fails', async () => {
    fakeAcquire({
      sftpRead: vi.fn().mockResolvedValue(Buffer.from('hello', 'utf8')),
      sftpWrite: vi.fn().mockRejectedValue(new Error('EACCES')),
    });
    const r = await editFileTool.handler(
      { environmentId: 'env_test', path: '/x', oldString: 'hello', newString: 'world' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('SFTP_WRITE_FAILED');
  });
});
