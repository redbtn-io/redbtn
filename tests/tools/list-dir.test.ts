/**
 * Vitest for native tool: list_dir (Env Phase C — fs pack)
 *
 * Verifies:
 *   - non-recursive single-level listing via session.sftpReaddir
 *   - recursive BFS walk with depth bound + ignore set
 *   - default ignore set (.git, node_modules, .next, dist) skips both
 *     inclusion and descent
 *   - user-provided ignore set merges with defaults
 *   - maxEntries cap reports truncated
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
import listDirTool from '../../src/lib/tools/native/list-dir';

type EntryType = 'file' | 'dir' | 'link' | 'other';

interface FakeEntry {
  name: string;
  type: EntryType;
  size: number;
  modifiedAt: Date;
}

interface FakeSession {
  sftpReaddir: ReturnType<typeof vi.fn>;
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

/**
 * Build a sftpReaddir mock backed by a directory map. Each key is the FULL
 * path the tool will request; the value is the array of fake entries to
 * return. ENOENT is thrown for unknown paths.
 */
function readdirMock(map: Record<string, FakeEntry[]>) {
  return vi.fn(async (path: string) => {
    if (!Object.prototype.hasOwnProperty.call(map, path)) {
      throw new Error(`ENOENT: ${path}`);
    }
    return map[path];
  });
}

const MTIME = new Date('2026-01-01T00:00:00Z');

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

describe('list_dir — schema', () => {
  test('requires envId + path', () => {
    expect(listDirTool.inputSchema.required).toEqual(['environmentId', 'path']);
    expect(listDirTool.server).toBe('fs');
  });
});

describe('list_dir — validation', () => {
  test('missing path → VALIDATION', async () => {
    const r = await listDirTool.handler({ environmentId: 'env_test' }, makeContext('user_a'));
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('non-array ignore → VALIDATION', async () => {
    const r = await listDirTool.handler(
      { environmentId: 'env_test', path: '/x', ignore: 'foo' as unknown as string[] },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('ignore array with non-string → VALIDATION', async () => {
    const r = await listDirTool.handler(
      { environmentId: 'env_test', path: '/x', ignore: ['ok', 42 as unknown as string] },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('maxEntries out of range → VALIDATION', async () => {
    const r = await listDirTool.handler(
      { environmentId: 'env_test', path: '/x', maxEntries: 100000 },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('list_dir — non-recursive', () => {
  test('returns entries with name + type + size + ISO modifiedAt', async () => {
    fakeAcquire({
      sftpReaddir: readdirMock({
        '/repo': [
          { name: 'a.ts', type: 'file', size: 100, modifiedAt: MTIME },
          { name: 'b.ts', type: 'file', size: 200, modifiedAt: MTIME },
          { name: 'sub', type: 'dir', size: 0, modifiedAt: MTIME },
        ],
      }),
    });
    const r = await listDirTool.handler(
      { environmentId: 'env_test', path: '/repo' },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.entries.length).toBe(3);
    expect(body.entries[0]).toEqual({
      name: 'a.ts',
      type: 'file',
      size: 100,
      modifiedAt: MTIME.toISOString(),
    });
    expect(body.recursive).toBe(false);
    expect(body.truncated).toBe(false);
  });

  test('default ignore set skips .git and node_modules at the top level', async () => {
    fakeAcquire({
      sftpReaddir: readdirMock({
        '/repo': [
          { name: 'src', type: 'dir', size: 0, modifiedAt: MTIME },
          { name: '.git', type: 'dir', size: 0, modifiedAt: MTIME },
          { name: 'node_modules', type: 'dir', size: 0, modifiedAt: MTIME },
          { name: 'README.md', type: 'file', size: 50, modifiedAt: MTIME },
        ],
      }),
    });
    const r = await listDirTool.handler(
      { environmentId: 'env_test', path: '/repo' },
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['src', 'README.md']);
  });

  test('user ignore merges with defaults', async () => {
    fakeAcquire({
      sftpReaddir: readdirMock({
        '/repo': [
          { name: 'src', type: 'dir', size: 0, modifiedAt: MTIME },
          { name: 'tmp', type: 'dir', size: 0, modifiedAt: MTIME },
          { name: '.git', type: 'dir', size: 0, modifiedAt: MTIME },
        ],
      }),
    });
    const r = await listDirTool.handler(
      { environmentId: 'env_test', path: '/repo', ignore: ['tmp'] },
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['src']);
  });

  test('NOT_FOUND when readdir returns ENOENT', async () => {
    fakeAcquire({ sftpReaddir: readdirMock({}) });
    const r = await listDirTool.handler(
      { environmentId: 'env_test', path: '/missing' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('NOT_FOUND');
  });

  test('maxEntries cap → truncated:true', async () => {
    const entries: FakeEntry[] = Array.from({ length: 600 }, (_, i) => ({
      name: `f${i}.txt`,
      type: 'file' as EntryType,
      size: i,
      modifiedAt: MTIME,
    }));
    fakeAcquire({ sftpReaddir: readdirMock({ '/repo': entries }) });
    const r = await listDirTool.handler(
      { environmentId: 'env_test', path: '/repo' }, // default 500
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.entries.length).toBe(500);
    expect(body.truncated).toBe(true);
  });
});

describe('list_dir — recursive', () => {
  test('walks subdirectories and joins relative paths', async () => {
    fakeAcquire({
      sftpReaddir: readdirMock({
        '/repo': [
          { name: 'src', type: 'dir', size: 0, modifiedAt: MTIME },
          { name: 'README.md', type: 'file', size: 10, modifiedAt: MTIME },
        ],
        '/repo/src': [
          { name: 'index.ts', type: 'file', size: 100, modifiedAt: MTIME },
          { name: 'utils', type: 'dir', size: 0, modifiedAt: MTIME },
        ],
        '/repo/src/utils': [
          { name: 'helpers.ts', type: 'file', size: 50, modifiedAt: MTIME },
        ],
      }),
    });
    const r = await listDirTool.handler(
      { environmentId: 'env_test', path: '/repo', recursive: true },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(names).toContain('src/index.ts');
    expect(names).toContain('src/utils');
    expect(names).toContain('src/utils/helpers.ts');
  });

  test('default ignore skips .git AND its subtree (no descent into ignored dirs)', async () => {
    const readdir = readdirMock({
      '/repo': [
        { name: 'src', type: 'dir', size: 0, modifiedAt: MTIME },
        { name: '.git', type: 'dir', size: 0, modifiedAt: MTIME },
      ],
      '/repo/src': [
        { name: 'a.ts', type: 'file', size: 100, modifiedAt: MTIME },
      ],
      // /repo/.git would have entries, but we should never read it
    });
    fakeAcquire({ sftpReaddir: readdir });
    await listDirTool.handler(
      { environmentId: 'env_test', path: '/repo', recursive: true },
      makeContext('user_a'),
    );
    const calls = readdir.mock.calls.map((c) => c[0]);
    expect(calls).toContain('/repo');
    expect(calls).toContain('/repo/src');
    expect(calls).not.toContain('/repo/.git');
  });

  test('subdir read failure is non-fatal (we continue the walk)', async () => {
    fakeAcquire({
      sftpReaddir: vi.fn(async (path: string) => {
        if (path === '/repo') {
          return [
            { name: 'good', type: 'dir' as EntryType, size: 0, modifiedAt: MTIME },
            { name: 'bad', type: 'dir' as EntryType, size: 0, modifiedAt: MTIME },
          ];
        }
        if (path === '/repo/good') {
          return [{ name: 'ok.txt', type: 'file' as EntryType, size: 1, modifiedAt: MTIME }];
        }
        if (path === '/repo/bad') {
          throw new Error('ENOENT');
        }
        throw new Error('ENOENT');
      }),
    });
    const r = await listDirTool.handler(
      { environmentId: 'env_test', path: '/repo', recursive: true },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('good');
    expect(names).toContain('bad');
    expect(names).toContain('good/ok.txt');
    // The bad dir's contents should NOT appear since the read failed.
  });

  test('root read failure → tool error', async () => {
    fakeAcquire({ sftpReaddir: vi.fn().mockRejectedValue(new Error('ENOENT')) });
    const r = await listDirTool.handler(
      { environmentId: 'env_test', path: '/missing', recursive: true },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('NOT_FOUND');
  });
});
