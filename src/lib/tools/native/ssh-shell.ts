/**
 * SSH Shell — Native System Tool
 *
 * Opens an SSH connection, runs a command, streams stdout/stderr back through
 * the RunPublisher in real-time. Returns the full output and exit code when
 * the command completes.
 *
 * Key characteristics vs. MCP stdio path:
 * - No JSON-RPC serialization overhead
 * - No hard 90-second timeout (configurable per call, default unlimited)
 * - RunPublisher access for live UI streaming
 * - Large output support (truncated at 100KB in return value, full output
 *   is available as the streaming feed)
 *
 * # Two execution modes (Phase B)
 *
 * 1. **environmentId mode (preferred)** — when `environmentId` is provided,
 *    the tool routes through `EnvironmentManager.acquire()` to use a pooled,
 *    drop-tolerant `EnvironmentSession`. First call opens the SSH session;
 *    subsequent calls reuse it (no per-call handshake). Inline `host`/`user`/
 *    `sshKey`/`sshKeyPath`/`password` are IGNORED in this mode.
 *
 * 2. **inline mode (legacy)** — when `environmentId` is omitted, the tool
 *    opens a one-shot SSH connection using the inline credentials, runs the
 *    command, and tears the connection down. Backwards-compatible — every
 *    existing graph that uses `ssh_shell` continues to work unchanged.
 *
 * For any sustained SSH usage (multiple calls to the same host), prefer the
 * environmentId mode — it removes the handshake cost and adds drop tolerance.
 */

import { Client, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as os from 'os';
import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { environmentManager } from '../../environments/EnvironmentManager';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';

// No limits — Claude sessions can produce large outputs and we need
// the full stream-json including the final result event
const MAX_RETURN_BYTES = Infinity;
const MAX_STDERR_BYTES = Infinity;
const MAX_BUFFER_BYTES = Infinity;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface SshShellArgs {
  /**
   * **Phase B (preferred):** Execute against a managed Environment session.
   * When supplied, all inline auth/host fields are ignored — the engine
   * loads the IEnvironment doc, resolves the secret, and routes through
   * `EnvironmentManager.acquire()` for connection pooling + drop tolerance.
   */
  environmentId?: string;
  host?: string;
  port?: number;
  user?: string;
  sshKeyPath?: string;
  sshKey?: string;
  password?: string;
  command: string;
  workingDir?: string;
  timeout?: number;
  env?: Record<string, string>;
}

const sshShell: NativeToolDefinition = {
  description: 'Execute a command on a remote machine via SSH with real-time output streaming. Returns stdout, stderr, and exit code. Pass `environmentId` (preferred) to use a pooled, drop-tolerant managed Environment session — first call opens, subsequent calls reuse. Inline `host`/`user`/`sshKey` still work for one-shot use.',
  server: 'system',

  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'PREFERRED: ID of a managed Environment configured under /api/v1/environments. When set, the tool uses a pooled SSH session (no per-call handshake, drop-tolerant). All inline host/user/sshKey fields are ignored when this is set.',
      },
      host: {
        type: 'string',
        description: 'SSH hostname or IP address (ignored when environmentId is set)',
      },
      port: {
        type: 'number',
        description: 'SSH port (default: 22)',
        default: 22,
      },
      user: {
        type: 'string',
        description: 'SSH username (default: alpha)',
        default: 'alpha',
      },
      sshKeyPath: {
        type: 'string',
        description: 'Path to SSH private key file on the worker machine. Supports ~ expansion.',
      },
      sshKey: {
        type: 'string',
        description: 'SSH private key content (PEM string). Use this instead of sshKeyPath when the key is stored in secrets.',
      },
      password: {
        type: 'string',
        description: 'SSH password. Only used when sshKeyPath is not provided.',
      },
      command: {
        type: 'string',
        description: 'Shell command to execute on the remote machine.',
      },
      workingDir: {
        type: 'string',
        description: 'Working directory on the remote machine. If set, the command is prefixed with cd <dir> &&.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds. 0 means no timeout (default: 0).',
        default: 0,
      },
      env: {
        type: 'object',
        description: 'Environment variables to export before running the command.',
        default: {},
      },
    },
    required: ['command'],
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = rawArgs as SshShellArgs;
    const {
      environmentId,
      host,
      port = 22,
      user = 'alpha',
      sshKeyPath,
      sshKey,
      password,
      command,
      workingDir,
      timeout = 0,
      env = {},
    } = args;

    const publisher = context?.publisher || null;
    const runId = context?.runId || null;
    const nodeId = context?.nodeId || 'ssh_shell';

    // -----------------------------------------------------------------------
    // Phase B: environmentId mode — route through EnvironmentManager
    //
    // When the caller passes an environmentId, we bypass the inline SSH path
    // entirely. The session is pooled per-process so subsequent invocations
    // reuse the same connection (no per-call handshake) and we get drop
    // tolerance "for free" via EnvironmentSession's reconnect machinery.
    // -----------------------------------------------------------------------
    if (environmentId && typeof environmentId === 'string') {
      return executeViaEnvironment({
        environmentId,
        command,
        workingDir,
        timeout,
        env,
        context,
        publisher,
        runId,
        nodeId,
      });
    }

    // -----------------------------------------------------------------------
    // Inline mode (legacy) — one-shot SSH connection
    //
    // Host is required when environmentId is not provided. Surface that as a
    // clean tool error rather than letting ssh2 throw `Cannot connect to
    // undefined`.
    // -----------------------------------------------------------------------
    if (!host) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'ssh_shell requires either `environmentId` (preferred) or inline `host` to connect',
          }),
        }],
        isError: true,
      };
    }

    console.log(`[ssh_shell] Connecting to ${user}@${host}:${port}`);
    console.log(`[ssh_shell] Command: ${command.substring(0, 200)}${command.length > 200 ? '...' : ''}`);
    if (runId) console.log(`[ssh_shell] Run: ${runId}, Node: ${nodeId}`);

    // Build the full command to execute on the remote shell
    let fullCommand = command;

    if (workingDir) {
      fullCommand = `cd ${JSON.stringify(workingDir)} && ${command}`;
    }

    if (env && Object.keys(env).length > 0) {
      const envExports = Object.entries(env)
        .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
        .join(' && ');
      fullCommand = `${envExports} && ${fullCommand}`;
    }

    return new Promise((resolve) => {
      const conn = new Client();
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let settled = false;
      const startTime = Date.now();

      const settle = (error: Error | null) => {
        if (settled) return;
        settled = true;

        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }

        if (statusInterval) {
          clearInterval(statusInterval);
          statusInterval = null;
        }

        try { conn.end(); } catch (_) { /* ignore */ }

        const duration = Date.now() - startTime;

        if (error) {
          console.error(`[ssh_shell] Error after ${duration}ms: ${error.message}`);
          resolve({
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error.message,
                stdout: stdout.length > MAX_RETURN_BYTES
                  ? stdout.substring(stdout.length - MAX_RETURN_BYTES)
                  : stdout,
                stderr: stderr.length > MAX_STDERR_BYTES
                  ? stderr.substring(stderr.length - MAX_STDERR_BYTES)
                  : stderr,
                exitCode,
                durationMs: duration,
              }),
            }],
            isError: true,
          });
          return;
        }

        const success = exitCode === 0;
        console.log(`[ssh_shell] Completed in ${duration}ms. exitCode=${exitCode}, stdout=${stdout.length}B, stderr=${stderr.length}B`);
        if (stderr.length > 0) console.log(`[ssh_shell] stderr: ${stderr.substring(0, 500)}`);
        // When the remote command fails, surface the output so diagnostics are
        // not lost. With 2>&1 redirection, error messages end up in stdout.
        if (!success) {
          const stdoutPreview = stdout.length > 1000 ? stdout.substring(0, 1000) + '...[truncated]' : stdout;
          console.error(`[ssh_shell] Non-zero exit (${exitCode}). stdout: ${stdoutPreview}`);
        }

        resolve({
          content: [{
            type: 'text',
            text: JSON.stringify({
              success,
              exitCode,
              stdout: stdout.length > MAX_RETURN_BYTES
                ? stdout.substring(stdout.length - MAX_RETURN_BYTES)
                : stdout,
              stderr: stderr.length > MAX_STDERR_BYTES
                ? stderr.substring(stderr.length - MAX_STDERR_BYTES)
                : stderr,
              totalBytes: stdout.length + stderr.length,
              truncated: stdout.length > MAX_RETURN_BYTES || stderr.length > MAX_STDERR_BYTES,
              durationMs: duration,
            }),
          }],
        });
      };

      if (timeout > 0) {
        timeoutTimer = setTimeout(() => {
          settle(new Error(`SSH command timed out after ${Math.round(timeout / 1000)}s`));
        }, timeout);
      }

      if (context?.abortSignal) {
        context.abortSignal.addEventListener('abort', () => {
          settle(new Error('SSH command aborted by caller'));
        }, { once: true });
      }

      const connConfig: ConnectConfig = {
        host,
        port,
        username: user,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 5,
      };

      if (sshKey) {
        // Key content passed directly (e.g. from secrets store)
        connConfig.privateKey = Buffer.from(sshKey, 'utf8');
        console.log(`[ssh_shell] Using key auth: inline key (${sshKey.length} chars)`);
      } else if (sshKeyPath) {
        const expandedPath = sshKeyPath.replace(/^~/, os.homedir());
        try {
          connConfig.privateKey = fs.readFileSync(expandedPath);
          console.log(`[ssh_shell] Using key auth: ${expandedPath}`);
        } catch (readErr: unknown) {
          const msg = readErr instanceof Error ? readErr.message : String(readErr);
          return settle(new Error(`Cannot read SSH key at '${expandedPath}': ${msg}`));
        }
      } else if (password) {
        connConfig.password = password;
        console.log('[ssh_shell] Using password auth');
      } else {
        console.warn('[ssh_shell] No auth method provided — connection may fail');
      }

      // Periodic status publisher — keeps client informed during long SSH runs
      let statusInterval: NodeJS.Timeout | null = null;

      conn.on('ready', () => {
        console.log(`[ssh_shell] SSH connection established to ${user}@${host}:${port}`);

        if (publisher) {
          try {
            (publisher as AnyObject).publish({
              type: 'tool_start',
              nodeId,
              data: {
                tool: 'ssh_shell',
                host,
                user,
                command: command.substring(0, 200),
                timestamp: Date.now(),
              },
            });
          } catch (pubErr: unknown) {
            const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
            console.warn('[ssh_shell] Failed to publish tool_start:', msg);
          }

          // Publish periodic status updates every 15 seconds so the UI shows activity
          statusInterval = setInterval(() => {
            if (settled) {
              if (statusInterval) clearInterval(statusInterval);
              return;
            }
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            try {
              (publisher as AnyObject).publish({
                type: 'status',
                action: 'running_command',
                description: `SSH command running (${elapsed}s, ${stdout.length + stderr.length} bytes)`,
                timestamp: Date.now(),
              });
            } catch (_) { /* ignore */ }
          }, 15000);
        }

        conn.exec(fullCommand, { pty: false }, (err, stream) => {
          if (err) {
            console.error('[ssh_shell] exec() failed:', err.message);
            return settle(err);
          }

          stream.on('data', (data: Buffer) => {
            const chunk = data.toString('utf8');
            stdout += chunk;

            // Rolling buffer — discard oldest bytes if we exceed the limit
            if (stdout.length > MAX_BUFFER_BYTES) {
              stdout = stdout.substring(stdout.length - MAX_BUFFER_BYTES);
            }

            if (publisher) {
              try {
                (publisher as AnyObject).publish({
                  type: 'tool_output',
                  nodeId,
                  data: { chunk, stream: 'stdout', totalBytes: stdout.length },
                });
              } catch (pubErr: unknown) {
                const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
                console.warn('[ssh_shell] Failed to publish stdout chunk:', msg);
              }
            }

            // Parser/streaming callback
            if (context.onChunk) {
              try {
                context.onChunk(chunk, 'stdout');
              } catch (cbErr: unknown) {
                const msg = cbErr instanceof Error ? cbErr.message : String(cbErr);
                console.warn('[ssh_shell] onChunk callback error (stdout):', msg);
              }
            }
          });

          stream.stderr.on('data', (data: Buffer) => {
            const chunk = data.toString('utf8');
            stderr += chunk;

            if (stderr.length > MAX_BUFFER_BYTES) {
              stderr = stderr.substring(stderr.length - MAX_BUFFER_BYTES);
            }

            if (publisher) {
              try {
                (publisher as AnyObject).publish({
                  type: 'tool_output',
                  nodeId,
                  data: { chunk, stream: 'stderr', totalBytes: stderr.length },
                });
              } catch (pubErr: unknown) {
                const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
                console.warn('[ssh_shell] Failed to publish stderr chunk:', msg);
              }
            }

            // Parser/streaming callback
            if (context.onChunk) {
              try {
                context.onChunk(chunk, 'stderr');
              } catch (cbErr: unknown) {
                const msg = cbErr instanceof Error ? cbErr.message : String(cbErr);
                console.warn('[ssh_shell] onChunk callback error (stderr):', msg);
              }
            }
          });

          stream.on('close', (code: number, signal: string) => {
            exitCode = code;
            if (signal) {
              console.log(`[ssh_shell] Process killed by signal: ${signal}`);
            }
            settle(null);
          });

          stream.on('error', (streamErr: Error) => {
            console.error('[ssh_shell] Stream error:', streamErr.message);
            settle(streamErr);
          });
        });
      });

      conn.on('error', (connErr: Error) => {
        console.error(`[ssh_shell] Connection error: ${connErr.message}`);
        settle(connErr);
      });

      conn.on('timeout', () => {
        settle(new Error(`SSH connection to ${host}:${port} timed out`));
      });

      conn.on('end', () => {
        if (!settled) {
          settle(new Error('SSH connection closed unexpectedly by remote'));
        }
      });

      conn.connect(connConfig);
    });
  },
};

// ---------------------------------------------------------------------------
// Phase B — environmentId-mode handler
// ---------------------------------------------------------------------------

interface ExecuteViaEnvironmentArgs {
  environmentId: string;
  command: string;
  workingDir?: string;
  timeout: number;
  env: Record<string, string>;
  context: NativeToolContext;
  publisher: AnyObject | null;
  runId: string | null;
  nodeId: string;
}

/**
 * Execute a command through the EnvironmentManager. Loads the IEnvironment
 * doc, resolves its secret, acquires (or reuses) the pooled session, and
 * runs the command via `session.exec()`.
 *
 * # Why this is a separate function
 *
 * The inline-SSH path is an entire ~250 line ssh2 promise dance. The
 * environment path is a 30-line acquire+exec. Splitting them keeps the
 * inline path completely unchanged for backwards compat, while letting the
 * env path stay readable.
 *
 * # State streaming
 *
 * `EnvironmentSession.exec` is request/response — it doesn't stream output
 * mid-command (the underlying ssh2 stream is buffered into stdout/stderr
 * tails before resolving). We still emit `tool_start` and a final
 * `tool_output` so the UI sees activity. For chunk-by-chunk streaming the
 * caller should use the inline path or the upcoming `ssh_run_async` (Phase
 * D) which is purpose-built for long-running commands.
 *
 * # Userid
 *
 * Pulled from `context.state.userId` (graph state root) — this is the
 * userId of the run that triggered the tool. The access check inside
 * `loadAndResolveEnvironment` enforces owner-OR-public.
 */
async function executeViaEnvironment(args: ExecuteViaEnvironmentArgs): Promise<NativeMcpResult> {
  const { environmentId, command, workingDir, timeout, env, context, publisher, runId, nodeId } = args;
  const startTime = Date.now();
  // userId source — graph state root (set by buildInitialState in run.ts) is
  // the canonical place. Defensive fallback to context.state.data.userId
  // for any caller that didn't go through the standard graph init path.
  const userId =
    (context?.state as AnyObject | undefined)?.userId
    || (context?.state as AnyObject | undefined)?.data?.userId
    || '';

  console.log(`[ssh_shell] env=${environmentId} cmd: ${command.substring(0, 200)}${command.length > 200 ? '...' : ''}`);
  if (runId) console.log(`[ssh_shell] Run: ${runId}, Node: ${nodeId}, User: ${userId}`);

  if (!userId) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: `ssh_shell with environmentId requires a userId in graph state — got empty. This usually means the tool was invoked outside a run context.`,
        }),
      }],
      isError: true,
    };
  }

  // ── Load + access-check + secret-resolve ────────────────────────────────
  let env_, sshKey;
  try {
    const resolved = await loadAndResolveEnvironment(environmentId, userId);
    env_ = resolved.env;
    sshKey = resolved.sshKey;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code || 'ENV_RESOLVE_FAILED';
    console.error(`[ssh_shell] Environment resolution failed for ${environmentId}: ${msg}`);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: msg,
          code,
          environmentId,
        }),
      }],
      isError: true,
    };
  }

  // ── Acquire session (pooled — first call opens, rest reuse) ─────────────
  let session;
  try {
    session = await environmentManager.acquire(env_, sshKey, userId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ssh_shell] EnvironmentManager.acquire failed for ${environmentId}: ${msg}`);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: `Failed to acquire environment session: ${msg}`,
          environmentId,
        }),
      }],
      isError: true,
    };
  }

  if (publisher) {
    try {
      (publisher as AnyObject).publish({
        type: 'tool_start',
        nodeId,
        data: {
          tool: 'ssh_shell',
          environmentId,
          host: env_.host,
          user: env_.user,
          command: command.substring(0, 200),
          timestamp: Date.now(),
          mode: 'environment',
        },
      });
    } catch (pubErr: unknown) {
      const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
      console.warn('[ssh_shell] Failed to publish tool_start:', msg);
    }
  }

  // ── Exec ────────────────────────────────────────────────────────────────
  try {
    const result = await session.exec(command, {
      cwd: workingDir,
      env,
      timeout: timeout > 0 ? timeout : undefined,
      abortSignal: context?.abortSignal || undefined,
    });
    const duration = Date.now() - startTime;
    const success = result.exitCode === 0;

    if (publisher) {
      try {
        (publisher as AnyObject).publish({
          type: 'tool_output',
          nodeId,
          data: {
            chunk: result.stdout,
            stream: 'stdout',
            totalBytes: result.stdout.length + result.stderr.length,
          },
        });
      } catch { /* ignore */ }
    }

    console.log(`[ssh_shell] env=${environmentId} completed in ${duration}ms exitCode=${result.exitCode} stdout=${result.stdout.length}B stderr=${result.stderr.length}B`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          totalBytes: result.stdout.length + result.stderr.length,
          truncated: result.truncated,
          durationMs: duration,
          environmentId,
        }),
      }],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const duration = Date.now() - startTime;
    console.error(`[ssh_shell] env=${environmentId} exec failed after ${duration}ms: ${msg}`);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: msg,
          environmentId,
          durationMs: duration,
        }),
      }],
      isError: true,
    };
  }
}

export default sshShell;
// Also export as module.exports for CJS require() compatibility (the .js files use require())
module.exports = sshShell;
