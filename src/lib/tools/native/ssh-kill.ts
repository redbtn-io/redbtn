/**
 * ssh_kill — Native System Tool (Env Phase D — process pack)
 *
 * Send a signal to a job started by `ssh_run_async`. The default signal is
 * `TERM` (graceful); pass `KILL` for a forced shutdown that the process
 * cannot trap.
 *
 * # How
 *
 * 1. Look up the job's PID in the Redis hash.
 * 2. SSH `kill -<signal> <pid>` on the remote.
 * 3. Update the job's hash entry: `status: 'killed'`, `exitedAt`.
 *
 * # Idempotent behaviour
 *
 * If the process has already exited (kill returns a non-zero exit code with
 * "No such process"), we still treat the call as successful — the contract
 * is "make sure this job isn't running anymore", not "deliver a signal that
 * has an in-flight target". The Redis status flips to 'killed' regardless.
 *
 * If the job was previously seen as `exited` (via `ssh_tail`), we still
 * issue the kill — sometimes the wrapper subshell hangs around even after
 * the inner command exits, so a redundant kill is harmless and tidy.
 *
 * # Inputs / outputs
 *
 *   Input:   { environmentId, jobId, signal? (default 'TERM') }
 *   Output:  { ok: true, terminatedAt }
 *
 * # Allowed signals
 *
 * `'TERM' | 'KILL' | 'INT' | 'HUP' | 'QUIT' | 'USR1' | 'USR2'`. We
 * deliberately constrain the set to the common, safe signals — accepting
 * arbitrary strings would let an LLM agent send malformed signals like
 * `'-9; rm -rf /'`. The validation also rejects numeric signals (e.g. `9`)
 * because the JSON Schema declares the field as a string with an enum.
 *
 * @module lib/tools/native/ssh-kill
 */

import type {
  NativeToolDefinition,
  NativeMcpResult,
  NativeToolContext,
} from '../native-registry';
import { environmentManager } from '../../environments/EnvironmentManager';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';
import {
  jobsHashKey,
  getRedisClient,
  type AsyncJobMetadata,
} from './ssh-run-async';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

const ALLOWED_SIGNALS = ['TERM', 'KILL', 'INT', 'HUP', 'QUIT', 'USR1', 'USR2'] as const;
type AllowedSignal = (typeof ALLOWED_SIGNALS)[number];
const DEFAULT_SIGNAL: AllowedSignal = 'TERM';

interface SshKillArgs {
  environmentId?: string;
  jobId?: string;
  signal?: string;
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

function resolveUserId(context: NativeToolContext): string {
  const state = (context?.state ?? {}) as AnyObject;
  return String(state.userId || state?.data?.userId || '');
}

const sshKill: NativeToolDefinition = {
  description:
    'Send a signal to a job started by ssh_run_async. Default signal TERM (graceful); use KILL for forced shutdown. Idempotent — succeeds even when the process has already exited. Updates the job status in the per-environment Redis index to `killed`.',
  server: 'system',

  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'ID of the managed Environment the job was started on.',
      },
      jobId: {
        type: 'string',
        description: 'Job ID returned by ssh_run_async.',
      },
      signal: {
        type: 'string',
        enum: [...ALLOWED_SIGNALS],
        description: 'Signal name to send. Default TERM (graceful). Use KILL for forced shutdown.',
        default: DEFAULT_SIGNAL,
      },
    },
    required: ['environmentId', 'jobId'],
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = (rawArgs ?? {}) as SshKillArgs;

    if (!args.environmentId || typeof args.environmentId !== 'string') {
      return validationError('environmentId is required and must be a string');
    }
    if (!args.jobId || typeof args.jobId !== 'string') {
      return validationError('jobId is required and must be a string');
    }

    let signal: AllowedSignal = DEFAULT_SIGNAL;
    if (args.signal !== undefined) {
      if (typeof args.signal !== 'string') {
        return validationError('signal must be a string when provided');
      }
      // Strip a leading SIG prefix if present — `kill -SIGTERM` and
      // `kill -TERM` both work but the unix convention is the short form.
      const normalized = args.signal.toUpperCase().replace(/^SIG/, '');
      if (!(ALLOWED_SIGNALS as readonly string[]).includes(normalized)) {
        return validationError(
          `signal must be one of: ${ALLOWED_SIGNALS.join(', ')} (got ${args.signal})`,
        );
      }
      signal = normalized as AllowedSignal;
    }

    const userId = resolveUserId(context);
    if (!userId) {
      return validationError(
        'ssh_kill requires a userId in graph state — got empty.',
        'MISSING_USER',
      );
    }

    const { environmentId, jobId } = args;

    // ── Look up PID ─────────────────────────────────────────────────────────
    let meta: AsyncJobMetadata | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redis: any = await getRedisClient();
      const raw = await redis.hget(jobsHashKey(environmentId), jobId);
      if (raw) {
        meta = JSON.parse(raw) as AsyncJobMetadata;
      }
    } catch (redisErr: unknown) {
      const msg = redisErr instanceof Error ? redisErr.message : String(redisErr);
      console.warn(`[ssh_kill] Redis lookup failed for env=${environmentId} job=${jobId}: ${msg}`);
    }

    if (!meta) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Job ${jobId} not found for environment ${environmentId}.`,
            code: 'JOB_NOT_FOUND',
            environmentId,
            jobId,
          }),
        }],
        isError: true,
      };
    }

    // ── Resolve env + acquire pooled session ────────────────────────────────
    let envDoc, sshKey;
    try {
      const resolved = await loadAndResolveEnvironment(environmentId, userId);
      envDoc = resolved.env;
      sshKey = resolved.sshKey;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string })?.code || 'ENV_RESOLVE_FAILED';
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: msg, code, environmentId }),
        }],
        isError: true,
      };
    }

    let session;
    try {
      session = await environmentManager.acquire(envDoc, sshKey, userId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
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

    // ── Send the signal ─────────────────────────────────────────────────────
    // We append `|| true` so the wrapper exec returns 0 even when kill itself
    // returns 1 (process already gone). Idempotent semantics — the caller's
    // intent is "make sure this isn't running" and "already gone" satisfies
    // that. We still report whether kill saw the process or not via
    // `processWasRunning`.
    //
    // We capture the kill exit code by echoing it after `||` so the parsed
    // output is unambiguous. If kill exits 0 the process was alive (and got
    // the signal). If it exits 1 the process was already gone.
    const killScript = `kill -${signal} ${meta.pid} 2>&1; echo "EXIT:$?"`;
    let killResult;
    try {
      killResult = await session.exec(killScript, { timeout: 30_000 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Kill command exec failed: ${msg}`,
            code: 'KILL_FAILED',
            environmentId,
            jobId,
          }),
        }],
        isError: true,
      };
    }

    // Parse the trailing "EXIT:<code>" sentinel.
    const stdoutTrimmed = killResult.stdout.trim();
    const exitMatch = stdoutTrimmed.match(/EXIT:(-?\d+)/);
    const killExitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : null;
    const processWasRunning = killExitCode === 0;
    const terminatedAt = new Date().toISOString();

    // ── Update Redis status to 'killed' ─────────────────────────────────────
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redis: any = await getRedisClient();
      const updated: AsyncJobMetadata = {
        ...meta,
        status: 'killed',
        exitedAt: terminatedAt,
        // We don't have the actual exit code here (kill races the wrapper's
        // exit-code write). Subsequent ssh_tail will pick it up via the
        // /tmp/<jobId>_exit file.
      };
      await redis.hset(jobsHashKey(environmentId), jobId, JSON.stringify(updated));
    } catch (redisErr: unknown) {
      const msg = redisErr instanceof Error ? redisErr.message : String(redisErr);
      console.warn(`[ssh_kill] Redis status update failed for env=${environmentId} job=${jobId}: ${msg}`);
    }

    console.log(`[ssh_kill] env=${environmentId} jobId=${jobId} pid=${meta.pid} signal=${signal} processWasRunning=${processWasRunning}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          ok: true,
          terminatedAt,
          jobId,
          environmentId,
          signal,
          pid: meta.pid,
          processWasRunning,
        }),
      }],
    };
  },
};

export default sshKill;
// See ssh-run-async.ts footer for the CJS-shim explanation.
