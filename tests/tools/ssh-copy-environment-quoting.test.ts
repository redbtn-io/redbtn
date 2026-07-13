/**
 * ssh_copy — environmentId mode `ensureRemoteDir` shell-quoting regression.
 *
 * `ensureRemoteDir` builds a `mkdir -p <dir>` command executed via
 * `session.exec()`. `dir` is derived from `remotePath` (when it's a
 * directory target) or from `file.filename` (which, for the `sourceUrl`
 * source, comes from a THIRD-PARTY server's `Content-Disposition` header —
 * not from the graph author). The value must be single-quote escaped
 * (shQuote), not `JSON.stringify`'d — double-quoting leaves `$(...)` /
 * backticks live to bash.
 *
 * Mirrors the mocking pattern in tests/environments/ssh-shell-environment.test.ts
 * — swaps EnvironmentManager's clientFactory for a MockSshClient and stubs
 * loadAndResolveEnvironment so no real Mongo/redsecrets/SSH is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';
import { buildEnv, MockSshClient, MockSshChannel } from '../environments/_helpers';

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
import sshCopyTool from '../../src/lib/tools/native/ssh-copy';

function buildContext(userId: string) {
  return {
    publisher: null,
    state: { userId },
    runId: 'run_test',
    nodeId: 'node_test',
    toolId: 'tool_test',
    abortSignal: null,
  };
}

describe('ssh_copy — environmentId mode ensureRemoteDir shell-quoting', () => {
  let clients: MockSshClient[];

  beforeEach(() => {
    environmentManager.__reset();
    clients = [];
    environmentManager.configure({
      clientFactory: (() => {
        const c = new MockSshClient();
        c.behaviour.onExec = (command: string, channel: MockSshChannel) => {
          channel.pushStdout('ok');
          setImmediate(() => channel.finish(0));
        };
        clients.push(c);
        return c;
      }) as unknown as Parameters<typeof environmentManager.configure>[0]['clientFactory'],
    });
  });

  afterEach(async () => {
    await environmentManager.closeAll();
    vi.clearAllMocks();
  });

  it('single-quotes a directory target containing a command substitution', async () => {
    const env = buildEnv({ environmentId: 'env_copy', userId: 'user_a' });
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env, sshKey: 'k' });

    const result = await sshCopyTool.handler(
      {
        environmentId: 'env_copy',
        // Trailing slash => isDirectory=true => ensureRemoteDir(remotePath)
        // is called directly with this LLM-controlled value.
        remotePath: '/tmp/$(touch /tmp/pwned)/',
        content: 'hello',
        filename: 'out.txt',
      },
      buildContext('user_a') as never,
    );

    expect(result.isError).toBeFalsy();
    // session.exec() prepends `cd '<workingDir>' && ` (env.workingDir), so
    // match on the mkdir segment rather than the whole command string.
    const mkdirCall = clients[0].execCalls.find((c) => c.includes('mkdir -p'));
    expect(mkdirCall).toBeDefined();
    expect(mkdirCall).toContain("mkdir -p '/tmp/$(touch /tmp/pwned)/'");
    expect(mkdirCall).not.toContain('mkdir -p "');
  });

  it('single-quotes a directory target containing an embedded single quote', async () => {
    const env = buildEnv({ environmentId: 'env_copy2', userId: 'user_a' });
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({ env, sshKey: 'k' });

    const result = await sshCopyTool.handler(
      {
        environmentId: 'env_copy2',
        remotePath: "/tmp/foo'; touch /tmp/pwned; echo '/",
        content: 'hello',
        filename: 'out.txt',
      },
      buildContext('user_a') as never,
    );

    expect(result.isError).toBeFalsy();
    const mkdirCall = clients[0].execCalls.find((c) => c.includes('mkdir -p'));
    expect(mkdirCall).toBeDefined();
    // Every `'` is closed/escaped/reopened — no unescaped quote breaks out.
    expect(mkdirCall).toContain("mkdir -p '/tmp/foo'\\''; touch /tmp/pwned; echo '\\''/'");
  });
});
