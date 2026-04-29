/**
 * Vitest for native tool: write_file (Env Phase C — fs pack)
 *
 * Happy path + atomic-write contract (we just verify the session's
 * sftpWrite was called with the right args, since the temp+rename atomicity
 * lives inside the session) + mode propagation + validation + error surface.
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
import writeFileTool from '../../src/lib/tools/native/write-file';

interface FakeSession {
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

describe('write_file — schema', () => {
  test('requires envId, path, content', () => {
    expect(writeFileTool.inputSchema.required).toEqual(['environmentId', 'path', 'content']);
    expect(writeFileTool.server).toBe('fs');
  });
});

describe('write_file — validation', () => {
  test('missing environmentId → VALIDATION', async () => {
    const r = await writeFileTool.handler({ path: '/x', content: 'hi' }, makeContext('user_a'));
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing content → VALIDATION', async () => {
    const r = await writeFileTool.handler({ environmentId: 'env_test', path: '/x' }, makeContext('user_a'));
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('non-string content → VALIDATION', async () => {
    const r = await writeFileTool.handler(
      { environmentId: 'env_test', path: '/x', content: 123 as unknown as string },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('out-of-range mode → VALIDATION', async () => {
    const r = await writeFileTool.handler(
      { environmentId: 'env_test', path: '/x', content: 'hi', mode: 999999 },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('empty userId → NO_USER', async () => {
    const r = await writeFileTool.handler(
      { environmentId: 'env_test', path: '/x', content: 'hi' },
      makeContext(''),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('NO_USER');
  });
});

describe('write_file — happy path', () => {
  test('writes content via session.sftpWrite and returns byte count', async () => {
    const sftpWrite = vi.fn().mockResolvedValue(undefined);
    fakeAcquire({ sftpWrite });
    const content = 'hello world';
    const r = await writeFileTool.handler(
      { environmentId: 'env_test', path: '/dest', content },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(body.path).toBe('/dest');
    expect(body.mode).toBe(0o644);
    expect(sftpWrite).toHaveBeenCalledWith('/dest', content, { mode: 0o644 });
  });

  test('passes through custom mode', async () => {
    const sftpWrite = vi.fn().mockResolvedValue(undefined);
    fakeAcquire({ sftpWrite });
    const r = await writeFileTool.handler(
      { environmentId: 'env_test', path: '/script.sh', content: '#!/bin/sh', mode: 0o755 },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).mode).toBe(0o755);
    expect(sftpWrite).toHaveBeenCalledWith('/script.sh', '#!/bin/sh', { mode: 0o755 });
  });

  test('multibyte UTF-8 content reports correct byte length', async () => {
    const sftpWrite = vi.fn().mockResolvedValue(undefined);
    fakeAcquire({ sftpWrite });
    const content = 'héllo — 世界';
    const r = await writeFileTool.handler(
      { environmentId: 'env_test', path: '/x', content },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).bytes).toBe(Buffer.byteLength(content, 'utf8'));
  });
});

describe('write_file — error surfaces', () => {
  test('NOT_FOUND when SFTP returns ENOENT (e.g. parent dir missing)', async () => {
    fakeAcquire({ sftpWrite: vi.fn().mockRejectedValue(new Error('ENOENT: /missing/dir/file')) });
    const r = await writeFileTool.handler(
      { environmentId: 'env_test', path: '/missing/dir/file', content: 'x' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('NOT_FOUND');
  });

  test('SFTP_WRITE_FAILED for other I/O errors', async () => {
    fakeAcquire({ sftpWrite: vi.fn().mockRejectedValue(new Error('EACCES /readonly')) });
    const r = await writeFileTool.handler(
      { environmentId: 'env_test', path: '/readonly', content: 'x' },
      makeContext('user_a'),
    );
    expect(JSON.parse(r.content[0].text).code).toBe('SFTP_WRITE_FAILED');
  });
});
