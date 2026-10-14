/**
 * view_image: the model SEES an image (MCP image block), from a path in the
 * environment or a URL downloaded inside it. Environment + session are faked
 * exactly like tests/tools/read-file.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { PNG } from 'pngjs';
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
import viewImageTool, { viewImageDeps, downloadNameFor } from '../../src/lib/tools/native/view-image';

function png(w: number, h: number): Buffer {
  const p = new PNG({ width: w, height: h });
  p.data.fill(200);
  return PNG.sync.write(p);
}

function ctx(state: Record<string, unknown> = { userId: 'user_a' }): NativeToolContext {
  return { publisher: null, state, runId: 'r', nodeId: 'n', toolId: 't', abortSignal: null } as NativeToolContext;
}

let session: { exec: ReturnType<typeof vi.fn>; sftpRead: ReturnType<typeof vi.fn>; sftpStat: ReturnType<typeof vi.fn> };

beforeEach(() => {
  environmentManager.__reset();
  vi.mocked(loadAndResolveEnvironment).mockResolvedValue({
    env: buildEnv({ environmentId: 'env_test', userId: 'user_a' }),
    sshKey: 'k',
  } as never);
  session = {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, durationMs: 5, truncated: false }),
    sftpRead: vi.fn().mockResolvedValue(png(40, 20)),
    sftpStat: vi.fn().mockResolvedValue({ size: 1000, isFile: true }),
  };
  vi.spyOn(environmentManager, 'acquire').mockResolvedValue(session as never);
});

afterEach(() => vi.restoreAllMocks());

describe('view_image', () => {
  test('path: returns an MCP image block the model can see, plus facts (and deletes nothing)', async () => {
    const res = await viewImageTool.handler({ environmentId: 'env_test', path: '/workspace/shot.png' }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(res.content[0].data as string, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const facts = JSON.parse(res.content[1].text as string);
    expect(facts).toMatchObject({ source: '/workspace/shot.png', width: 40, height: 20 });
    expect(session.sftpRead).toHaveBeenCalledWith('/workspace/shot.png');
    expect(session.exec).not.toHaveBeenCalled();
  });

  test('relative paths resolve against the working directory; environmentId falls back to state', async () => {
    await viewImageTool.handler({ path: 'docs/a.png' }, ctx({ userId: 'user_a', data: { environmentId: 'env_test' } }));
    expect(session.sftpRead).toHaveBeenCalledWith(expect.stringMatching(/\/docs\/a\.png$/));
  });

  test('url: downloaded INSIDE the environment with curl, then read back', async () => {
    const url = 'https://board.redbtn.io/api/files/abc/IMG_9989.PNG?sig=1';
    const res = await viewImageTool.handler({ environmentId: 'env_test', url }, ctx());
    expect(res.isError).toBeFalsy();
    const cmd = session.exec.mock.calls[0][0] as string;
    expect(cmd).toContain('curl -fsSL');
    expect(cmd).toContain(`'${url}'`);
    // Inside the working directory (a workspace jails SFTP to its exec root,
    // so /tmp is refused), and deleted again once read.
    const saved = session.sftpRead.mock.calls[0][0] as string;
    expect(saved).toMatch(/\/\.view-image\/.+-IMG_9989\.PNG$/);
    expect(JSON.parse(res.content[1].text as string)).toMatchObject({ source: url });
    const cleanup = session.exec.mock.calls[1][0] as string;
    expect(cleanup).toContain(`rm -f '${saved}'`);
  });

  test('a failed download says why (links expire)', async () => {
    session.exec.mockResolvedValue({ stdout: '', stderr: 'curl: (22) 403', exitCode: 22, durationMs: 1, truncated: false });
    const res = await viewImageTool.handler({ environmentId: 'env_test', url: 'https://x.example/a.png' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/403[\s\S]*24 h[\s\S]*DOWNLOAD_FAILED/);
  });

  test('a shell-hostile URL is single-quoted, never interpreted', async () => {
    await viewImageTool.handler({ environmentId: 'env_test', url: "https://x.example/a.png?q='$(id)'" }, ctx());
    const cmd = session.exec.mock.calls[0][0] as string;
    expect(cmd).toContain(`'https://x.example/a.png?q='\\''$(id)'\\'''`);
  });

  test('describe=true adds a written description from the vision model', async () => {
    const spy = vi.spyOn(viewImageDeps, 'describe').mockResolvedValue('grey rectangle, no text');
    const res = await viewImageTool.handler({ environmentId: 'env_test', path: '/workspace/a.png', describe: true }, ctx());
    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.parse(res.content[1].text as string).description).toBe('grey rectangle, no text');
  });

  test('validation: exactly one of path/url; not an image is refused', async () => {
    expect((await viewImageTool.handler({ environmentId: 'env_test' }, ctx())).isError).toBe(true);
    expect((await viewImageTool.handler({ environmentId: 'env_test', path: 'a', url: 'https://b' }, ctx())).isError).toBe(true);
    expect((await viewImageTool.handler({ environmentId: 'env_test', url: 'file:///etc/passwd' }, ctx())).isError).toBe(true);
    session.sftpRead.mockResolvedValue(Buffer.from('just text'));
    const res = await viewImageTool.handler({ environmentId: 'env_test', path: '/workspace/notes.txt' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('UNSUPPORTED_FORMAT');
  });

  test('downloadNameFor keeps a safe basename', () => {
    expect(downloadNameFor('https://h/x/IMG 1.png?sig=2')).toMatch(/-IMG_1\.png$/);
    expect(downloadNameFor('not a url')).toMatch(/-image$/);
  });
});
