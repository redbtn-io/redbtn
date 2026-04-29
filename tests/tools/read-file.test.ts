/**
 * Vitest for native tool: read_file (Env Phase C — fs pack)
 *
 * Per ENVIRONMENT-HANDOFF.md §2 Phase C / §6.1 — happy path + offset/limit
 * windowing + line-number prefix + truncation reporting + validation +
 * upstream error surface.
 *
 * The test mocks `loadAndResolveEnvironment` (so we don't touch Mongo or
 * redsecrets) and stubs the `environmentManager.acquire` path with a fake
 * session whose `sftpRead` returns a fixed Buffer. Mirrors the pattern from
 * tests/environments/ssh-shell-environment.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';
import { buildEnv } from '../environments/_helpers';

vi.mock('../../src/lib/environments/loadAndResolveEnvironment', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/loadAndResolveEnvironment')>(
    '../../src/lib/environments/loadAndResolveEnvironment',
  );
  return {
    ...actual,
    loadAndResolveEnvironment: vi.fn(),
  };
});

import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import readFileTool from '../../src/lib/tools/native/read-file';

interface FakeSession {
  sftpRead: ReturnType<typeof vi.fn>;
}

function makeContext(userId: string, overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId },
    runId: 'test-run',
    nodeId: 'test-node',
    toolId: 'test-tool',
    abortSignal: null,
    ...overrides,
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

describe('read_file — schema', () => {
  test('exposes required + optional fields', () => {
    expect(readFileTool.inputSchema.required).toEqual(['environmentId', 'path']);
    expect(readFileTool.inputSchema.properties.environmentId).toBeDefined();
    expect(readFileTool.inputSchema.properties.path).toBeDefined();
    expect(readFileTool.inputSchema.properties.offset).toBeDefined();
    expect(readFileTool.inputSchema.properties.limit).toBeDefined();
    expect(readFileTool.server).toBe('fs');
  });
});

describe('read_file — validation', () => {
  test('missing environmentId → VALIDATION', async () => {
    const r = await readFileTool.handler({ path: '/x' }, makeContext('user_a'));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing path → VALIDATION', async () => {
    const r = await readFileTool.handler({ environmentId: 'env_test' }, makeContext('user_a'));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('negative offset → VALIDATION', async () => {
    const r = await readFileTool.handler(
      { environmentId: 'env_test', path: '/x', offset: -1 },
      makeContext('user_a'),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('zero limit → VALIDATION', async () => {
    const r = await readFileTool.handler(
      { environmentId: 'env_test', path: '/x', limit: 0 },
      makeContext('user_a'),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('empty userId → NO_USER', async () => {
    const r = await readFileTool.handler(
      { environmentId: 'env_test', path: '/x' },
      makeContext(''),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('NO_USER');
    expect(loadAndResolveEnvironment).not.toHaveBeenCalled();
  });
});

describe('read_file — happy path', () => {
  test('returns line-numbered content for the whole file', async () => {
    const text = ['alpha', 'beta', 'gamma', 'delta'].join('\n') + '\n';
    fakeAcquire({ sftpRead: vi.fn().mockResolvedValue(Buffer.from(text, 'utf8')) });

    const r = await readFileTool.handler(
      { environmentId: 'env_test', path: '/notes.txt' },
      makeContext('user_a'),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text);
    expect(body.totalLines).toBe(4);
    expect(body.lineCount).toBe(4);
    expect(body.truncated).toBe(false);
    // 1-indexed line-numbered prefix, tab-separated
    expect(body.content).toBe('1\talpha\n2\tbeta\n3\tgamma\n4\tdelta');
  });

  test('handles file with no trailing newline', async () => {
    fakeAcquire({ sftpRead: vi.fn().mockResolvedValue(Buffer.from('one\ntwo', 'utf8')) });
    const r = await readFileTool.handler(
      { environmentId: 'env_test', path: '/x' },
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.totalLines).toBe(2);
    expect(body.content).toBe('1\tone\n2\ttwo');
  });

  test('offset slices from a specific line', async () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    fakeAcquire({ sftpRead: vi.fn().mockResolvedValue(Buffer.from(text, 'utf8')) });

    const r = await readFileTool.handler(
      { environmentId: 'env_test', path: '/x', offset: 5 },
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.totalLines).toBe(10);
    expect(body.lineCount).toBe(5);
    expect(body.content.split('\n')[0]).toBe('6\tline6');
    expect(body.content.split('\n')[4]).toBe('10\tline10');
    // sliceStart is reported back as `offset`
    expect(body.offset).toBe(5);
  });

  test('limit caps the slice and reports truncated:true', async () => {
    const text = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join('\n');
    fakeAcquire({ sftpRead: vi.fn().mockResolvedValue(Buffer.from(text, 'utf8')) });

    const r = await readFileTool.handler(
      { environmentId: 'env_test', path: '/x', limit: 10 },
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.totalLines).toBe(100);
    expect(body.lineCount).toBe(10);
    expect(body.truncated).toBe(true);
    expect(body.content.split('\n').length).toBe(10);
  });

  test('offset beyond EOF → empty slice, totalLines preserved', async () => {
    fakeAcquire({ sftpRead: vi.fn().mockResolvedValue(Buffer.from('one\ntwo', 'utf8')) });
    const r = await readFileTool.handler(
      { environmentId: 'env_test', path: '/x', offset: 50 },
      makeContext('user_a'),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.totalLines).toBe(2);
    expect(body.lineCount).toBe(0);
    expect(body.content).toBe('');
  });

  test('uses state.data.userId fallback when state.userId missing', async () => {
    fakeAcquire({ sftpRead: vi.fn().mockResolvedValue(Buffer.from('hi', 'utf8')) });
    const r = await readFileTool.handler(
      { environmentId: 'env_test', path: '/x' },
      {
        publisher: null,
        state: { data: { userId: 'user_a' } },
        runId: null,
        nodeId: null,
        toolId: null,
        abortSignal: null,
      },
    );
    expect(r.isError).toBeUndefined();
    expect(loadAndResolveEnvironment).toHaveBeenCalledWith('env_test', 'user_a');
  });
});

describe('read_file — error surfaces', () => {
  test('NOT_FOUND when SFTP returns ENOENT', async () => {
    fakeAcquire({ sftpRead: vi.fn().mockRejectedValue(new Error('ENOENT: /missing')) });
    const r = await readFileTool.handler(
      { environmentId: 'env_test', path: '/missing' },
      makeContext('user_a'),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('NOT_FOUND');
  });

  test('SFTP_READ_FAILED for other I/O errors', async () => {
    fakeAcquire({ sftpRead: vi.fn().mockRejectedValue(new Error('EIO disk error')) });
    const r = await readFileTool.handler(
      { environmentId: 'env_test', path: '/x' },
      makeContext('user_a'),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('SFTP_READ_FAILED');
  });

  test('surfaces ENV_NOT_FOUND from loadAndResolveEnvironment', async () => {
    vi.mocked(loadAndResolveEnvironment).mockRejectedValueOnce(
      Object.assign(new Error('Environment not found: env_xx'), { code: 'ENV_NOT_FOUND' }),
    );
    const r = await readFileTool.handler(
      { environmentId: 'env_xx', path: '/x' },
      makeContext('user_a'),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('ENV_NOT_FOUND');
  });
});
