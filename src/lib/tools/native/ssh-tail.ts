/**
 * ssh_tail — Native System Tool (Env Phase D — process pack)
 *
 * Read the most recent stdout / stderr lines from a job started by
 * `ssh_run_async`, plus the job's run/exit status. Designed to be called
 * repeatedly by an agent that's polling a long-running task.
 *
 * # How status is detected
 *
 * Per the v1 spec (ENVIRONMENT-HANDOFF.md §2 Phase D), the source of truth
 * for liveness lives on the remote filesystem:
 *
 *   - `/tmp/<jobId>_out`  — stdout tail (rolling, the OS appends)
 *   - `/tmp/<jobId>_err`  — stderr tail
 *   - `/tmp/<jobId>_exit` — written by the wrapper subshell AFTER the user
 *                            command exits. Contains a single integer.
 *
 * To check liveness we issue `kill -0 <pid>`:
 *
 *   - exit 0 → process exists (`isRunning: true`)
 *   - exit 1 → process gone (`isRunning: false`)
 *
 * If `isRunning: false`, we read `/tmp/<jobId>_exit` to capture the actual
 * exit code. If the file doesn't exist yet (the process exited but the
 * wrapper subshell hasn't yet written the file — happens for ~1 tick on slow
 * filesystems), we report `exitCode: null` and trust a follow-up poll to
 * pick it up.
 *
 * # Why a single composite SSH exec
 *
 * We bundle the four sub-queries into ONE SSH exec call so we only pay the
 * channel-open cost once per `ssh_tail`:
 *
 *   tail -n N /tmp/jobId_out 2>/dev/null; printf '\0\0STDERR\0\0'
 *   tail -n N /tmp/jobId_err 2>/dev/null; printf '\0\0ALIVE\0\0'
 *   kill -0 PID 2>/dev/null && echo 1 || echo 0; printf '\0\0EXIT\0\0'
 *   cat /tmp/jobId_exit 2>/dev/null || echo NONE
 *
 * The `\0\0<TAG>\0\0` separators are pairs of NUL bytes around an ASCII tag
 * — extremely unlikely to appear in legitimate command output. We split on
 * those tags to recover each section.
 *
 * # Status reconciliation back to Redis
 *
 * If we observe a job has exited (kill -0 returned 1), we update the job's
 * Redis hash entry: `status: 'exited'`, `exitCode`, `exitedAt`. Subsequent
 * `ssh_jobs` calls show the freshly-detected exit without re-issuing kill -0.
 *
 * # Inputs / outputs
 *
 *   Input:   { environmentId, jobId, lines? (default 50), follow? (future) }
 *   Output:  { stdout, stderr, exitCode?, isRunning, status }
 *
 * # follow: true is reserved for future
 *
 * The spec mentions a `follow` flag as a future hook. v1 always returns a
 * single snapshot — we accept the flag for forward-compat but do not yet
 * stream. (Streaming would require a different transport contract because the
 * native-tool result type is request/response.)
 *
 * @module lib/tools/native/ssh-tail
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

const DEFAULT_LINES = 50;
const MAX_LINES = 10_000;

interface SshTailArgs {
  environmentId?: string;
  jobId?: string;
  lines?: number;
  follow?: boolean;
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

/**
 * Sentinel separators used to split the composite SSH output. Pairs of NUL
 * bytes flank an ASCII tag. We use NUL because shell `tail`/`cat` won't
 * naturally emit them (binary terminal/log output is rare and our
 * coding-agent tools work against text files).
 */
const TAG_STDERR = '\0\0STDERR\0\0';
const TAG_ALIVE = '\0\0ALIVE\0\0';
const TAG_EXIT = '\0\0EXIT\0\0';

/**
 * Build the composite read script. Echoes happen via printf `\0\0TAG\0\0`
 * because plain `echo` will quote-mangle the NULs on some shells. printf is
 * portable.
 *
 * `tail -n N FILE 2>/dev/null` returns empty (and a 0 exit) if the file
 * doesn't exist yet — fine for our purposes (an agent might race the wrapper
 * and call ssh_tail before the redirect targets are even created).
 */
function buildReadScript(jobId: string, pid: number, lines: number): string {
  const outFile = `/tmp/${jobId}_out`;
  const errFile = `/tmp/${jobId}_err`;
  const exitFile = `/tmp/${jobId}_exit`;
  // printf with \0 produces literal NUL bytes; the surrounding quoting keeps
  // bash from interpreting any of the tag characters.
  const sep = (label: string) => `printf '\\0\\0${label}\\0\\0'`;
  return [
    `tail -n ${lines} ${outFile} 2>/dev/null`,
    `${sep('STDERR')}`,
    `tail -n ${lines} ${errFile} 2>/dev/null`,
    `${sep('ALIVE')}`,
    `kill -0 ${pid} 2>/dev/null && echo 1 || echo 0`,
    `${sep('EXIT')}`,
    `cat ${exitFile} 2>/dev/null || echo NONE`,
  ].join('; ');
}

/**
 * Split the composite stdout into stdout / stderr / alive / exitCode
 * sections. The separators are NUL-flanked tags written by printf.
 *
 * Robustness: if a tag is missing (e.g. SSH closed the channel mid-read) we
 * fall back to reasonable defaults. This is rare enough that we don't bother
 * surfacing it as an error — the next poll will get a clean read.
 */
function parseReadOutput(raw: string): {
  stdout: string;
  stderr: string;
  isRunning: boolean;
  exitCodeRaw: string;
} {
  const parts = raw.split(TAG_STDERR);
  const stdout = parts[0] ?? '';
  const rest1 = parts[1] ?? '';

  const parts2 = rest1.split(TAG_ALIVE);
  const stderr = parts2[0] ?? '';
  const rest2 = parts2[1] ?? '';

  const parts3 = rest2.split(TAG_EXIT);
  const aliveRaw = (parts3[0] ?? '').trim();
  const exitCodeRaw = (parts3[1] ?? '').trim();

  // `kill -0 PID && echo 1 || echo 0` produces exactly "0" or "1" on its own
  // line. If the line ends up multi-line (shouldn't happen but defensive),
  // take the last token.
  const aliveToken = aliveRaw.split(/\s+/).pop() ?? '0';
  const isRunning = aliveToken === '1';

  return { stdout, stderr, isRunning, exitCodeRaw };
}

const sshTail: NativeToolDefinition = {
  description:
    'Read the most recent stdout/stderr lines and run/exit status of a job started by ssh_run_async. Polls the remote for liveness via kill -0 and the exit code from /tmp/<jobId>_exit. Default lines=50. Returns { stdout, stderr, exitCode?, isRunning, status }. Updates the per-environment job index in Redis when a freshly-detected exit is observed.',
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
      lines: {
        type: 'integer',
        description: 'How many recent lines of stdout/stderr to return (1-10000). Default 50.',
        default: DEFAULT_LINES,
        minimum: 1,
        maximum: MAX_LINES,
      },
      follow: {
        type: 'boolean',
        description: 'Reserved for future streaming mode. Currently always returns a single snapshot.',
        default: false,
      },
    },
    required: ['environmentId', 'jobId'],
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = (rawArgs ?? {}) as SshTailArgs;

    if (!args.environmentId || typeof args.environmentId !== 'string') {
      return validationError('environmentId is required and must be a string');
    }
    if (!args.jobId || typeof args.jobId !== 'string') {
      return validationError('jobId is required and must be a string');
    }

    let lines = DEFAULT_LINES;
    if (args.lines !== undefined) {
      if (typeof args.lines !== 'number' || !Number.isInteger(args.lines)) {
        return validationError('lines must be an integer when provided');
      }
      if (args.lines < 1 || args.lines > MAX_LINES) {
        return validationError(`lines must be between 1 and ${MAX_LINES}`);
      }
      lines = args.lines;
    }

    if (args.follow !== undefined && typeof args.follow !== 'boolean') {
      return validationError('follow must be a boolean when provided');
    }

    const userId = resolveUserId(context);
    if (!userId) {
      return validationError(
        'ssh_tail requires a userId in graph state — got empty.',
        'MISSING_USER',
      );
    }

    const { environmentId, jobId } = args;

    // ── Look up the job in Redis to get its PID ─────────────────────────────
    // We need the PID for the kill -0 check. Without it we can't determine
    // liveness. The job hash entry also gives us the original metadata so we
    // can fold updated status back without a fresh exec.
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
      console.warn(`[ssh_tail] Redis lookup failed for env=${environmentId} job=${jobId}: ${msg}`);
      // Fall through — we can't recover without the PID, so this is a
      // user-visible error. (We don't return early here so the response
      // shape is consistent with the JOB_NOT_FOUND path below.)
    }

    if (!meta) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Job ${jobId} not found for environment ${environmentId}. It may have been cleaned up (24h TTL) or never existed.`,
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

    // ── Composite read ──────────────────────────────────────────────────────
    let composite;
    try {
      composite = await session.exec(buildReadScript(jobId, meta.pid, lines), {
        timeout: 30_000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Read script failed: ${msg}`,
            code: 'READ_FAILED',
            environmentId,
            jobId,
          }),
        }],
        isError: true,
      };
    }

    // The composite script ALWAYS exits 0 because every step uses `... ||
    // <fallback>` — non-zero would mean ssh2 itself failed (which we caught
    // above). Defensive: if exitCode is non-zero, surface it but still try
    // to parse what we got.
    if (composite.exitCode !== 0) {
      console.warn(`[ssh_tail] Composite read exited ${composite.exitCode} for env=${environmentId} job=${jobId}`);
    }

    const parsed = parseReadOutput(composite.stdout);

    // ── Resolve exitCode ────────────────────────────────────────────────────
    // The exit-code file may legitimately not yet exist (cat returned NONE),
    // OR may contain a stale code from a previous job (shouldn't happen because
    // we mint a unique jobId per call, but defensive).
    let exitCode: number | null | undefined = undefined;
    if (parsed.exitCodeRaw && parsed.exitCodeRaw !== 'NONE') {
      const n = Number.parseInt(parsed.exitCodeRaw.trim(), 10);
      if (Number.isFinite(n)) exitCode = n;
    }

    // ── Reconcile status back to Redis if the job has exited ────────────────
    let statusUpdate: 'exited' | undefined;
    if (!parsed.isRunning && meta.status === 'running') {
      // First poll that observes the exit. Update the hash so ssh_jobs
      // reflects it without redoing the kill -0.
      statusUpdate = 'exited';
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const redis: any = await getRedisClient();
        const updated: AsyncJobMetadata = {
          ...meta,
          status: 'exited',
          exitCode: exitCode ?? null,
          exitedAt: new Date().toISOString(),
        };
        await redis.hset(jobsHashKey(environmentId), jobId, JSON.stringify(updated));
      } catch (redisErr: unknown) {
        const msg = redisErr instanceof Error ? redisErr.message : String(redisErr);
        console.warn(`[ssh_tail] Redis status reconciliation failed for env=${environmentId} job=${jobId}: ${msg}`);
      }
    } else if (!parsed.isRunning && meta.status !== 'running') {
      // Job was already known to be exited — preserve the recorded exitCode.
      // Only fall back to the freshly-read one if the recorded one is missing.
      if (exitCode === undefined && meta.exitCode !== undefined) {
        exitCode = meta.exitCode;
      }
    }

    const status: 'running' | 'exited' | 'killed' = parsed.isRunning
      ? 'running'
      : (statusUpdate ?? meta.status);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          jobId,
          environmentId,
          stdout: parsed.stdout,
          stderr: parsed.stderr,
          isRunning: parsed.isRunning,
          // Only include exitCode key when we actually have one — avoids
          // misleading callers into thinking exitCode=null === "still running".
          ...(exitCode !== undefined ? { exitCode } : {}),
          status,
          pid: meta.pid,
        }),
      }],
    };
  },
};

export default sshTail;
// See ssh-run-async.ts footer for the CJS-shim explanation. Same pattern
// here — registry uses `.default || X` so the standard TS CJS output works.
