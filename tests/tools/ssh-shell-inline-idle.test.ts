import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAsync, MockSshChannel, MockSshClient } from '../environments/_helpers';
import sshShellTool, { __setSshClientFactoryForTests } from '../../src/lib/tools/native/ssh-shell';

function parseToolResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('ssh_shell inline output-idle watchdog', () => {
  let clients: MockSshClient[];

  beforeEach(() => {
    clients = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    __setSshClientFactoryForTests(null);
    vi.restoreAllMocks();
  });

  function useMockClientFactory(configureClient: (client: MockSshClient) => void) {
    __setSshClientFactoryForTests(() => {
      const client = new MockSshClient();
      configureClient(client);
      clients.push(client);
      return client as unknown as ReturnType<NonNullable<Parameters<typeof __setSshClientFactoryForTests>[0]>>;
    });
  }

  it('kills and returns an error when inline command produces no output for the idle window', async () => {
    let primaryChannel: MockSshChannel | null = null;
    useMockClientFactory((client) => {
      client.behaviour.onExec = (command, channel) => {
        if (command.startsWith('kill ')) {
          channel.finish(0);
          return;
        }
        primaryChannel = channel;
        channel.pushStderr('__RDBTN_PID__=4242\n');
      };
    });

    const resultPromise = sshShellTool.handler(
      {
        host: 'localhost',
        user: 'alpha',
        command: 'sleep 100',
        timeout: 25,
      },
      {} as any,
    );

    await expect(resultPromise).rejects.toThrow('produced no output');
    expect(primaryChannel?.signalled).toBe('KILL');
    expect(clients[0].execCalls.some((cmd) => cmd.includes('kill -TERM -- -4242'))).toBe(true);
  });

  it('resets the inline idle window on every stdout chunk and completes streaming commands', async () => {
    let primaryChannel: MockSshChannel | null = null;
    useMockClientFactory((client) => {
      client.behaviour.onExec = (command, channel) => {
        if (command.startsWith('kill ')) {
          channel.finish(0);
          return;
        }
        primaryChannel = channel;
        channel.pushStderr('__RDBTN_PID__=4243\n');
        let count = 0;
        const tick = () => {
          count += 1;
          channel.pushStdout(`chunk-${count}\n`);
          if (count >= 5) {
            channel.finish(0);
            return;
          }
          setTimeout(tick, 10);
        };
        setTimeout(tick, 10);
      };
    });

    const result = await sshShellTool.handler(
      {
        host: 'localhost',
        user: 'alpha',
        command: 'stream',
        timeout: 25,
      },
      {} as any,
    );
    const body = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(body.success).toBe(true);
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('chunk-5');
    expect(primaryChannel?.signalled).toBeNull();
  });

  it('resets the inline idle window on stderr chunks too', async () => {
    useMockClientFactory((client) => {
      client.behaviour.onExec = (command, channel) => {
        if (command.startsWith('kill ')) {
          channel.finish(0);
          return;
        }
        channel.pushStderr('__RDBTN_PID__=4244\n');
        let count = 0;
        const tick = () => {
          count += 1;
          channel.pushStderr(`err-${count}\n`);
          if (count >= 4) {
            channel.finish(0);
            return;
          }
          setTimeout(tick, 10);
        };
        setTimeout(tick, 10);
      };
    });

    const result = await sshShellTool.handler(
      {
        host: 'localhost',
        user: 'alpha',
        command: 'stream-stderr',
        timeout: 25,
      },
      {} as any,
    );
    const body = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(body.success).toBe(true);
    expect(body.stderr).toContain('err-4');
  });

  it('clears the inline idle timer and closes the connection on caller abort', async () => {
    const abortController = new AbortController();
    let primaryChannel: MockSshChannel | null = null;

    useMockClientFactory((client) => {
      client.behaviour.onExec = (command, channel) => {
        if (command.startsWith('kill ')) {
          channel.finish(0);
          return;
        }
        primaryChannel = channel;
        channel.pushStderr('__RDBTN_PID__=4245\n');
      };
    });

    const resultPromise = sshShellTool.handler(
      {
        host: 'localhost',
        user: 'alpha',
        command: 'sleep 100',
        timeout: 60,
      },
      { abortSignal: abortController.signal } as any,
    );

    await flushAsync();
    expect(primaryChannel).not.toBeNull();

    abortController.abort();
    const result = await resultPromise;
    const body = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(body.success).toBe(false);
    expect(body.error).toContain('aborted by caller');
    expect(clients[0].ended).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(primaryChannel?.signalled).toBeNull();
    expect(clients[0].execCalls.some((cmd) => cmd.includes('kill -TERM -- -4245'))).toBe(false);
  });
});
