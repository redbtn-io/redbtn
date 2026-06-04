/**
 * Run Command — Environment-scoped shell execution
 *
 * Execute a shell command on a managed Environment. SSH details are handled
 * transparently by the engine — the LLM only needs to supply the command.
 *
 * # environmentId resolution order
 *
 * 1. `args.environmentId` — explicit per-call override (uncommon; useful for
 *    multi-environment graphs that switch targets mid-run)
 * 2. `context.state.data.environmentId` — the normal case: set once by the
 *    graph's preflight/setup node and reused by every subsequent tool call.
 *    The LLM never has to pass it.
 *
 * This pattern mirrors how `read_file`, `write_file`, etc. work — the tool
 * enforces the environmentId requirement at the handler level, but the graph
 * author injects the value into state so the LLM doesn't have to manage it.
 *
 * # Relationship to ssh_shell
 *
 * `run_command` is the high-level, environment-aware shell tool for use in
 * coding-agent graphs. `ssh_shell` is the lower-level, full-credential
 * version for one-shot or inline-SSH-credential use cases. For sustained
 * coding work, prefer `run_command` — it hides SSH from the LLM, reads the
 * environmentId from state, and routes through the same pooled
 * EnvironmentSession (no per-call handshake).
 *
 * # Output
 *
 * Returns the same `{ success, exitCode, stdout, stderr, durationMs }` shape
 * as `ssh_shell` so callers that switch between the two see identical output.
 */

import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { environmentManager } from '../../environments/EnvironmentManager';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface RunCommandArgs {
  command: string;
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  /** Explicit environmentId override. Normally omitted — resolved from graph state. */
  environmentId?: string;
}

function validationError(message: string): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code: 'VALIDATION', isError: true, success: false }) }],
    isError: true,
  };
}

function toolError(code: string, message: string, extra?: AnyObject): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code, isError: true, success: false, ...extra }) }],
    isError: true,
  };
}

const runCommandTool: NativeToolDefinition = {
  description:
    'Execute a shell command on the configured coding environment. SSH and connection details are handled automatically — just provide the command. ' +
    'Returns stdout, stderr, exit code, and duration. Use `cwd` to set working directory. ' +
    'For long-running processes (builds, tests, watchers) use ssh_run_async instead.',
  server: 'system',

  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute. Runs inside bash -c.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command (absolute path). Defaults to the environment home/default dir.',
      },
      timeout: {
        type: 'integer',
        description: 'Timeout in milliseconds. Default: no timeout. Use for commands that might hang.',
        minimum: 100,
      },
      env: {
        type: 'object',
        description: 'Additional environment variables to set for this command.',
        additionalProperties: { type: 'string' },
      },
      environmentId: {
        type: 'string',
        description: 'Override the environment to run in. Normally omitted — the graph supplies this automatically from state.',
      },
    },
    required: ['command'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<RunCommandArgs>;

    // ── Validate command ──────────────────────────────────────────────────
    if (!args.command || typeof args.command !== 'string' || args.command.trim() === '') {
      return validationError('command is required and must be a non-empty string');
    }
    if (args.timeout !== undefined && (typeof args.timeout !== 'number' || args.timeout < 100)) {
      return validationError('timeout must be a positive integer >= 100');
    }

    // ── Resolve environmentId: arg override → graph state ────────────────
    const state = context?.state as AnyObject | undefined;
    const environmentId: string =
      (args.environmentId && typeof args.environmentId === 'string' ? args.environmentId : null)
      ?? state?.data?.environmentId
      ?? '';

    if (!environmentId) {
      return validationError(
        'No environmentId available. Either pass environmentId explicitly, or ensure the graph preflight ' +
        'has written one to state.data.environmentId. Configure an Environment at /studio/environments/.',
      );
    }

    // ── userId ────────────────────────────────────────────────────────────
    const userId = state?.userId || state?.data?.userId || '';
    if (!userId) {
      return toolError(
        'NO_USER',
        'run_command requires a userId in graph state — got empty. This usually means the tool was invoked outside a run context.',
      );
    }

    const command = args.command;
    const workingDir = args.cwd;
    const timeout = args.timeout ?? 0;
    const envVars = args.env;
    const startTime = Date.now();
    const publisher = context?.publisher ?? null;
    const runId = context?.runId ?? null;
    const nodeId = context?.nodeId ?? 'unknown';

    console.log(`[run_command] env=${environmentId} cmd: ${command.substring(0, 200)}${command.length > 200 ? '...' : ''}`);
    if (runId) console.log(`[run_command] Run: ${runId}, Node: ${nodeId}, User: ${userId}`);

    // ── Load + access-check + resolve SSH key ─────────────────────────────
    let resolvedEnv, sshKey;
    try {
      const resolved = await loadAndResolveEnvironment(environmentId, userId);
      resolvedEnv = resolved.env;
      sshKey = resolved.sshKey;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string })?.code || 'ENV_RESOLVE_FAILED';
      console.error(`[run_command] Environment resolution failed for ${environmentId}: ${msg}`);
      return toolError(code, msg, { environmentId });
    }

    // ── Acquire pooled session ────────────────────────────────────────────
    let session;
    try {
      session = await environmentManager.acquire(resolvedEnv, sshKey, userId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[run_command] EnvironmentManager.acquire failed for ${environmentId}: ${msg}`);
      return toolError('ENV_ACQUIRE_FAILED', `Failed to acquire environment session: ${msg}`, { environmentId });
    }

    // ── Publish tool_start ────────────────────────────────────────────────
    if (publisher) {
      try {
        (publisher as AnyObject).publish({
          type: 'tool_start',
          nodeId,
          data: {
            tool: 'run_command',
            environmentId,
            command: command.substring(0, 200),
            timestamp: Date.now(),
          },
        });
      } catch { /* ignore */ }
    }

    // ── Execute ───────────────────────────────────────────────────────────
    try {
      const result = await session.exec(command, {
        cwd: workingDir,
        env: envVars,
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

      console.log(`[run_command] env=${environmentId} completed in ${duration}ms exitCode=${result.exitCode} stdout=${result.stdout.length}B stderr=${result.stderr.length}B`);

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
          }),
        }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - startTime;
      const isAbort = msg.includes('abort') || msg.includes('cancel');
      console.error(`[run_command] env=${environmentId} exec failed after ${duration}ms: ${msg}`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: msg,
            code: isAbort ? 'ABORTED' : 'EXEC_FAILED',
            durationMs: duration,
          }),
        }],
        isError: true,
      };
    }
  },
};

export = runCommandTool;
