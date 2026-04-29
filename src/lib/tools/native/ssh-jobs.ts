/**
 * ssh_jobs — Native System Tool (Env Phase D — process pack)
 *
 * Enumerate the jobs known to a managed Environment. Reads the per-environment
 * Redis hash that `ssh_run_async` populates and `ssh_tail` / `ssh_kill` keep
 * in sync.
 *
 * # What this returns vs reality
 *
 * The hash is the engine's "best knowledge" of jobs it has launched. It does
 * NOT tell you about processes started outside this tool (e.g. via plain
 * `ssh_shell`) — those are invisible to us by design. The hash is also
 * eventually consistent with reality:
 *   - A job that exits between polls will still show `status: 'running'`
 *     until the next `ssh_tail` reconciles it.
 *   - A job whose Redis entry expired (24h TTL) is gone from the index even
 *     if its remote PID is somehow still alive (extremely unlikely after a
 *     full day with no contact).
 *
 * For up-to-the-second status of a specific job, callers should follow up
 * with `ssh_tail` — that's the cheap way to refresh.
 *
 * # No SSH calls
 *
 * Unlike the other three tools in the pack, `ssh_jobs` is purely Redis-side.
 * No environment session is acquired, no remote command is executed. This
 * makes it cheap and immune to SSH-side failures — useful when the remote is
 * temporarily unreachable but the agent still wants to know what jobs it has
 * outstanding.
 *
 * We DO still validate the user's access to the environment via
 * `loadAndResolveEnvironment` because the per-environment job index could
 * theoretically expose execution metadata (commands, env vars) that the
 * caller shouldn't see.
 *
 * # Inputs / outputs
 *
 *   Input:  { environmentId }
 *   Output: { jobs: [{ jobId, command, startedAt, status, exitCode?,
 *                       isRunning, pid, exitedAt? }] }
 *
 * Jobs are sorted by `startedAt` descending (newest first) — usually what an
 * agent wants when tail-listing.
 *
 * @module lib/tools/native/ssh-jobs
 */

import type {
  NativeToolDefinition,
  NativeMcpResult,
  NativeToolContext,
} from '../native-registry';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';
import {
  jobsHashKey,
  getRedisClient,
  type AsyncJobMetadata,
} from './ssh-run-async';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface SshJobsArgs {
  environmentId?: string;
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

const sshJobs: NativeToolDefinition = {
  description:
    'List all jobs the engine knows about for a managed Environment. Reads the Redis-backed per-environment job index; does NOT issue any SSH commands. For up-to-the-second job status, follow up with ssh_tail. Jobs older than 24h with no activity are auto-pruned.',
  server: 'system',

  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'ID of the managed Environment whose jobs to list.',
      },
    },
    required: ['environmentId'],
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = (rawArgs ?? {}) as SshJobsArgs;

    if (!args.environmentId || typeof args.environmentId !== 'string') {
      return validationError('environmentId is required and must be a string');
    }

    const userId = resolveUserId(context);
    if (!userId) {
      return validationError(
        'ssh_jobs requires a userId in graph state — got empty.',
        'MISSING_USER',
      );
    }

    const { environmentId } = args;

    // ── Access check ────────────────────────────────────────────────────────
    // We don't need the resolved sshKey here (no exec), but we DO need to
    // confirm the caller is allowed to see this env's jobs. The owner-or-public
    // policy in loadAndResolveEnvironment is the right gate.
    try {
      await loadAndResolveEnvironment(environmentId, userId);
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

    // ── HGETALL the per-env hash ────────────────────────────────────────────
    let raw: Record<string, string> = {};
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redis: any = await getRedisClient();
      raw = (await redis.hgetall(jobsHashKey(environmentId))) ?? {};
    } catch (redisErr: unknown) {
      const msg = redisErr instanceof Error ? redisErr.message : String(redisErr);
      console.warn(`[ssh_jobs] Redis HGETALL failed for env=${environmentId}: ${msg}`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Failed to read jobs hash: ${msg}`,
            code: 'REDIS_FAILED',
            environmentId,
          }),
        }],
        isError: true,
      };
    }

    const jobs: Array<{
      jobId: string;
      command: string;
      cwd?: string;
      startedAt: string;
      status: 'running' | 'exited' | 'killed';
      exitCode?: number | null;
      isRunning: boolean;
      pid: number;
      exitedAt?: string;
    }> = [];

    for (const [jobId, json] of Object.entries(raw)) {
      try {
        const meta = JSON.parse(json) as AsyncJobMetadata;
        jobs.push({
          jobId: meta.jobId ?? jobId,
          command: meta.command,
          cwd: meta.cwd,
          startedAt: meta.startedAt,
          status: meta.status,
          ...(meta.exitCode !== undefined ? { exitCode: meta.exitCode } : {}),
          isRunning: meta.status === 'running',
          pid: meta.pid,
          ...(meta.exitedAt ? { exitedAt: meta.exitedAt } : {}),
        });
      } catch (parseErr: unknown) {
        // A malformed entry shouldn't block the rest of the listing. Log it
        // and move on — Redis hash entries can occasionally get scrambled if
        // someone manually edits them.
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        console.warn(`[ssh_jobs] Skipping malformed entry for env=${environmentId} jobId=${jobId}: ${msg}`);
      }
    }

    // Sort newest-first by startedAt. Defensive against missing/invalid dates.
    jobs.sort((a, b) => {
      const ta = Date.parse(a.startedAt) || 0;
      const tb = Date.parse(b.startedAt) || 0;
      return tb - ta;
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          environmentId,
          count: jobs.length,
          jobs,
        }),
      }],
    };
  },
};

export default sshJobs;
// See ssh-run-async.ts footer for the CJS-shim explanation.
