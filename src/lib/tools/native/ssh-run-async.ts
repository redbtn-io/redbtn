/**
 * ssh_run_async — Native System Tool (Env Phase D — process pack)
 *
 * Kick off a long-running shell command on a managed Environment without
 * waiting for it to finish. Returns a `jobId` immediately; the command keeps
 * running on the remote host. Use `ssh_tail` to inspect output, `ssh_kill`
 * to terminate, and `ssh_jobs` to enumerate.
 *
 * # Why this exists
 *
 * The default `ssh_shell` blocks until the remote process exits. That's the
 * right semantic for short commands (build, test, deploy). Long-running
 * commands (`npm run dev`, `tail -f`, model inference, training jobs) need a
 * fire-and-forget pattern: launch on the remote, get a handle, check on it
 * later. That's the process-pack contract.
 *
 * # How it works on the remote
 *
 * Per ENVIRONMENT-HANDOFF.md §2 Phase D and §4.2, we go file-backed instead
 * of in-memory streaming. The wrapper looks like:
 *
 *   bash -c '(nohup <command> > /tmp/job_<id>_out 2> /tmp/job_<id>_err;
 *             echo $? > /tmp/job_<id>_exit) & echo $!'
 *
 * The OUTER subshell:
 *   1. Wraps the user command in a backgrounded subshell `( ... ) &`
 *   2. Echoes the PID of that subshell (`$!`) to stdout — that's what we
 *      capture and stash in Redis
 *
 * The INNER subshell:
 *   1. Runs the user command with stdout/stderr redirected to log files
 *   2. AFTER the command exits, writes the exit code to a third file
 *   3. Because it's all inside `( ... ) &`, the entire pipeline runs
 *      asynchronously — our SSH exec call returns instantly with just the PID.
 *
 * `nohup` is included so the remote process survives a TTY hangup (which can
 * happen if the SSH connection blips). Combined with our pooled
 * `EnvironmentSession`, this gives the remote process the best chance of
 * outliving any transient network issues.
 *
 * # Why this is better than worker-side polling
 *
 * Tracking long-running processes from the worker would require:
 *   - A poller per job (memory leak across worker restarts)
 *   - State synchronization between workers (they share the same Redis but
 *     not in-memory state)
 *   - Liveness detection (worker crashed? job re-run? state stale?)
 *
 * File-backed remote state side-steps all of this: the source of truth IS
 * the remote filesystem. Any worker can call `ssh_tail` and read the same
 * files. Worker restarts don't lose any state.
 *
 * # Job metadata in Redis
 *
 * We DO keep a per-environment job index in Redis (`env:{envId}:jobs`)
 * mapping `jobId → { command, cwd, env, startedAt, status, pid }`. This is
 * just bookkeeping for `ssh_jobs` — it lets us enumerate jobs without
 * shelling out to the remote. The hash has a 24h TTL.
 *
 * # Inputs / outputs
 *
 *   Input:   { environmentId, command, cwd?, env? }
 *   Output:  { jobId, startedAt }   (on success)
 *            { isError: true, ... } (on failure)
 *
 * # Errors surface as tool errors (isError:true)
 *
 *   - Bad input (missing environmentId/command, wrong types) → VALIDATION
 *   - userId missing in graph state → MISSING_USER
 *   - Environment lookup / access / secret resolution failures pass through
 *     with their original code (ENV_NOT_FOUND, ENV_ACCESS_DENIED, ...)
 *   - Manager.acquire failure → ACQUIRE_FAILED
 *   - Remote exec failure (couldn't even start the wrapper) → EXEC_FAILED
 *   - Bad PID returned (non-numeric, empty) → BAD_PID
 *
 * @module lib/tools/native/ssh-run-async
 */

import { randomBytes } from 'crypto';
import type {
  NativeToolDefinition,
  NativeMcpResult,
  NativeToolContext,
} from '../native-registry';
import { environmentManager } from '../../environments/EnvironmentManager';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

/** Per-environment Redis hash key holding `jobId → JSON metadata`. */
export function jobsHashKey(environmentId: string): string {
  return `env:${environmentId}:jobs`;
}

/** TTL on the per-environment jobs hash. After 24h with no activity it expires. */
const JOBS_HASH_TTL_SECONDS = 24 * 60 * 60;

/** Standard nanoid URL-safe alphabet (matches generate-id.ts). */
const NANOID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/**
 * Build a fresh job ID. Format: `job_<8 chars>` — 8 chars from a 64-symbol
 * alphabet gives ~48 bits of entropy, comfortably collision-free for any
 * realistic per-environment job count (you'd need millions of concurrent
 * jobs in a single environment for a birthday-paradox collision).
 *
 * Implementation matches `generate-id.ts` so output looks consistent across
 * the toolbox.
 */
function makeJobId(): string {
  const bytes = randomBytes(8);
  let id = '';
  for (let i = 0; i < bytes.length; i++) {
    id += NANOID_ALPHABET[bytes[i] & 0x3f];
  }
  return `job_${id}`;
}

interface SshRunAsyncArgs {
  environmentId?: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** JSON metadata stored in the per-environment Redis hash. */
export interface AsyncJobMetadata {
  jobId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  startedAt: string;     // ISO 8601
  status: 'running' | 'exited' | 'killed';
  pid: number;
  /** Cached exit code once we've polled and seen it (set by ssh_tail). */
  exitCode?: number | null;
  /** When the job was observed exiting (set by ssh_tail). */
  exitedAt?: string;
}

function validationError(message: string, code = 'VALIDATION'): NativeMcpResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ success: false, error: message, code }),
      },
    ],
    isError: true,
  };
}

/**
 * Resolve userId from the graph state root, falling back to nested data
 * (mirrors the helper used by ssh-shell/ssh-copy).
 */
function resolveUserId(context: NativeToolContext): string {
  const state = (context?.state ?? {}) as AnyObject;
  return String(state.userId || state?.data?.userId || '');
}

/**
 * Build the wrapper command we run on the remote. Quoting + redirection
 * details matter — see the module-level JSDoc for the full breakdown.
 *
 * Why all the JSON.stringify: it's a fast, stable way to produce a single
 * shell-safe single-quoted-or-double-quoted token. Bash treats double-quoted
 * strings with backslash-escaped chars sensibly, and Node's JSON.stringify
 * always escapes the inner double-quotes that would terminate the string.
 *
 * Why we run it through `bash -c`: gives us subshell + backgrounding semantics
 * regardless of the user's login shell on the remote (some might be `sh`,
 * some `zsh`, some `dash`). Bash is the lingua franca for our user base and
 * is available everywhere we run.
 */
function buildWrapperCommand(
  jobId: string,
  command: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): string {
  const outFile = `/tmp/${jobId}_out`;
  const errFile = `/tmp/${jobId}_err`;
  const exitFile = `/tmp/${jobId}_exit`;

  // Pre-build the command body. We deliberately do NOT cd inside the
  // background subshell unless a cwd was specified — letting the user's
  // remote-side `~`-expansion semantics apply.
  let body = command;

  if (env && Object.keys(env).length > 0) {
    const envExports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
      .join(' && ');
    body = `${envExports} && ${body}`;
  }

  if (cwd) {
    body = `cd ${JSON.stringify(cwd)} && ${body}`;
  }

  // The async wrapper. Note the `& echo $!` is OUTSIDE the subshell — that's
  // why we get the PID of the BACKGROUNDED subshell, not the inner command.
  // To kill the actual user process we'd need to kill the subshell's group,
  // but `kill -TERM <pid>` against the subshell PID will propagate the signal
  // to its child via job-control bookkeeping. Good enough for v1.
  //
  // The trailing newline + `disown` would orphan the process from bash's job
  // table, but we're already inside a fire-and-forget `bash -c` so the parent
  // shell exits as soon as the backgrounded subshell is launched. No disown
  // needed.
  const inner = `(nohup bash -c ${JSON.stringify(body)} > ${outFile} 2> ${errFile}; echo $? > ${exitFile}) & echo $!`;

  return `bash -c ${JSON.stringify(inner)}`;
}

const sshRunAsync: NativeToolDefinition = {
  description:
    'Start a long-running shell command on a managed Environment without waiting for it to finish. Returns { jobId, startedAt } immediately. Use ssh_tail to inspect output, ssh_kill to terminate, ssh_jobs to enumerate. The command runs under nohup with stdout/stderr captured to /tmp/<jobId>_out and /tmp/<jobId>_err on the remote — survives SSH drops.',
  server: 'system',

  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description:
          'ID of a managed Environment configured under /api/v1/environments. Required.',
      },
      command: {
        type: 'string',
        description: 'Shell command to execute on the remote machine.',
      },
      cwd: {
        type: 'string',
        description:
          'Working directory on the remote machine. If set, the wrapper prefixes the command with `cd <dir> && `.',
      },
      env: {
        type: 'object',
        description: 'Environment variables to export before running the command.',
        default: {},
      },
    },
    required: ['environmentId', 'command'],
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = (rawArgs ?? {}) as SshRunAsyncArgs;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!args.environmentId || typeof args.environmentId !== 'string') {
      return validationError('environmentId is required and must be a string');
    }
    if (!args.command || typeof args.command !== 'string') {
      return validationError('command is required and must be a string');
    }
    if (args.cwd !== undefined && typeof args.cwd !== 'string') {
      return validationError('cwd must be a string when provided');
    }
    if (
      args.env !== undefined &&
      args.env !== null &&
      (typeof args.env !== 'object' || Array.isArray(args.env))
    ) {
      return validationError('env must be an object when provided');
    }

    const userId = resolveUserId(context);
    if (!userId) {
      return validationError(
        'ssh_run_async requires a userId in graph state — got empty. This usually means the tool was invoked outside a run context.',
        'MISSING_USER',
      );
    }

    const { environmentId, command, cwd, env } = args;
    const publisher = context?.publisher || null;
    const nodeId = context?.nodeId || 'ssh_run_async';
    const runId = context?.runId || null;

    console.log(`[ssh_run_async] env=${environmentId} cmd: ${command.substring(0, 200)}${command.length > 200 ? '...' : ''}`);
    if (runId) console.log(`[ssh_run_async] Run: ${runId}, Node: ${nodeId}, User: ${userId}`);

    // ── Load + access-check + secret-resolve ────────────────────────────────
    let envDoc, sshKey;
    try {
      const resolved = await loadAndResolveEnvironment(environmentId, userId);
      envDoc = resolved.env;
      sshKey = resolved.sshKey;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string })?.code || 'ENV_RESOLVE_FAILED';
      console.error(`[ssh_run_async] Environment resolution failed for ${environmentId}: ${msg}`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: msg, code, environmentId }),
        }],
        isError: true,
      };
    }

    // ── Acquire pooled session ──────────────────────────────────────────────
    let session;
    try {
      session = await environmentManager.acquire(envDoc, sshKey, userId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ssh_run_async] EnvironmentManager.acquire failed for ${environmentId}: ${msg}`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Failed to acquire environment session: ${msg}`,
            code: 'ACQUIRE_FAILED',
            environmentId,
          }),
        }],
        isError: true,
      };
    }

    // ── Mint the jobId, build the wrapper, exec it ──────────────────────────
    const jobId = makeJobId();
    const startedAt = new Date().toISOString();
    const wrapper = buildWrapperCommand(jobId, command, cwd, env);

    if (publisher) {
      try {
        (publisher as AnyObject).publish({
          type: 'tool_start',
          nodeId,
          data: {
            tool: 'ssh_run_async',
            environmentId,
            host: envDoc.host,
            user: envDoc.user,
            command: command.substring(0, 200),
            jobId,
            timestamp: Date.now(),
          },
        });
      } catch (pubErr: unknown) {
        const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
        console.warn('[ssh_run_async] Failed to publish tool_start:', msg);
      }
    }

    let pid: number;
    try {
      const result = await session.exec(wrapper, {
        // No cwd here — cwd is baked into the wrapper body. We do NOT want
        // session.exec to ALSO `cd ...` because we already did.
        env: undefined,
        // Wrapper itself is instant; if it doesn't return within 30 seconds
        // something is very wrong. The user command keeps running regardless.
        timeout: 30_000,
      });

      if (result.exitCode !== 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `Wrapper exec returned non-zero exit code (${result.exitCode}). stderr: ${result.stderr.substring(0, 500)}`,
              code: 'EXEC_FAILED',
              environmentId,
            }),
          }],
          isError: true,
        };
      }

      // The wrapper's stdout is just the PID followed by a newline.
      const pidStr = result.stdout.trim();
      const parsed = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== pidStr) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `Wrapper returned non-numeric PID: ${JSON.stringify(pidStr)}`,
              code: 'BAD_PID',
              environmentId,
              stdout: result.stdout.substring(0, 200),
              stderr: result.stderr.substring(0, 200),
            }),
          }],
          isError: true,
        };
      }
      pid = parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ssh_run_async] Wrapper exec failed for env=${environmentId}: ${msg}`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: msg,
            code: 'EXEC_FAILED',
            environmentId,
          }),
        }],
        isError: true,
      };
    }

    // ── Stash job metadata in Redis ─────────────────────────────────────────
    // Best-effort. If Redis is unavailable, the job still ran and the user
    // can interact with it via tail/kill (they need the jobId — we return
    // it in the response). ssh_jobs would just miss this entry.
    const meta: AsyncJobMetadata = {
      jobId,
      command,
      cwd,
      env,
      startedAt,
      status: 'running',
      pid,
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redis: any = await getRedisClient();
      const key = jobsHashKey(environmentId);
      const pipeline = redis.pipeline();
      pipeline.hset(key, jobId, JSON.stringify(meta));
      pipeline.expire(key, JOBS_HASH_TTL_SECONDS);
      await pipeline.exec();
    } catch (redisErr: unknown) {
      const msg = redisErr instanceof Error ? redisErr.message : String(redisErr);
      console.warn(`[ssh_run_async] Redis stash failed (job ${jobId} still launched): ${msg}`);
    }

    console.log(`[ssh_run_async] env=${environmentId} jobId=${jobId} pid=${pid} launched`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          jobId,
          startedAt,
          pid,
          environmentId,
        }),
      }],
    };
  },
};

// ---------------------------------------------------------------------------
// Redis client — module-level singleton shared by all four process-pack tools.
// Created on first use; reused across calls. We do NOT use the run publisher's
// Redis (it's a private field) because the process pack is independent of
// any single run — jobs outlive the run that started them.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _redisClient: any = null;

/**
 * Get-or-create the shared Redis client. We import ioredis lazily so this
 * file can be loaded in environments where ioredis isn't installed (the tool
 * call would fail at this line, which is correct).
 */
export async function getRedisClient(): Promise<unknown> {
  if (_redisClient) return _redisClient;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Redis = require('ioredis');
  // ioredis exports either as `module.exports = Redis` or as `{ default: Redis }`
  // depending on the version. Support both.
  const RedisCtor = Redis.default || Redis;
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  _redisClient = new RedisCtor(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  // Surface errors but don't crash the worker — the next call will retry.
  _redisClient.on('error', (err: Error) => {
    console.warn(`[ssh_run_async] Redis client error: ${err.message}`);
  });
  return _redisClient;
}

/**
 * Test hook — replace the cached Redis client. Tests inject an ioredis-mock
 * instance so the suite doesn't need a real Redis.
 */
export function __setRedisClientForTests(client: unknown): void {
  _redisClient = client;
}

export default sshRunAsync;
// NB: we deliberately do NOT do `module.exports = sshRunAsync` here — that's
// the pattern used by tools that have NO named exports beyond the default
// (ssh-shell, ssh-copy, etc). This module exports a handful of helpers
// (jobsHashKey, getRedisClient, AsyncJobMetadata, __setRedisClientForTests)
// that the sibling process-pack tools import. Overwriting module.exports
// with the tool def would clobber those helpers when the file is loaded via
// require() from compiled JS. The native-registry already calls
// `sshRunAsync.default || sshRunAsync` so the absence of the CJS shim is
// fine — TypeScript's `export default` compiles to `exports.default = ...`
// in CJS output, which is exactly what the registry expects.
