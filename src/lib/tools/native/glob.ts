/**
 * Glob — Native FS Tool (Env Phase C — fs pack)
 *
 * Find files matching a shell glob pattern (with `**` recursion support) on a
 * managed Environment. Uses SSH exec under the hood — bash with `globstar`,
 * `dotglob`, and `nullglob` enabled — because SFTP itself has no glob
 * primitive and translating arbitrary shell patterns into SFTP walk + filter
 * is more error-prone than just letting bash do its job.
 *
 * Spec: ENVIRONMENT-HANDOFF.md §2 Phase C / §4.1
 *   - inputs:  environmentId (required), pattern (required), basePath?
 *   - output:  { paths: [...], total }
 *
 * Implementation:
 *   - Builds `cd <basePath || .> && bash -c 'shopt -s globstar dotglob nullglob; printf "%s\\n" <pattern>'`
 *     so:
 *       - `globstar` enables `**` to match any number of directory levels
 *       - `dotglob` includes hidden files (matches Claude Code's expectation)
 *       - `nullglob` returns empty when no matches (instead of literal pattern)
 *   - Pattern is single-quoted in the shell command to prevent the local shell
 *     from expanding it before the remote bash sees it. Pattern itself is
 *     allow-listed to printable ASCII + glob meta-chars to keep injection out.
 *   - Caps total at MAX_RESULTS so a `**` against /usr doesn't OOM the worker.
 */

import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { environmentManager } from '../../environments/EnvironmentManager';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GlobArgs {
  environmentId: string;
  pattern: string;
  basePath?: string;
}

const MAX_RESULTS = 1000;
const GLOB_SAFE_PATTERN = /^[A-Za-z0-9_./*?[\]{}!@,~+\-=:#% ^]+$/;

function validationError(message: string): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code: 'VALIDATION', isError: true }) }],
    isError: true,
  };
}

function toolError(code: string, message: string, extra?: AnyObject): NativeMcpResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: message, code, isError: true, ...extra }),
    }],
    isError: true,
  };
}

const globTool: NativeToolDefinition = {
  description:
    'Find files on a managed Environment matching a shell glob pattern (supports `**` recursion, hidden files included). Returns up to 1000 paths. Optionally scope to a basePath. Requires environmentId.',
  server: 'fs',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'ID of the managed Environment configured under /api/v1/environments. Required.',
      },
      pattern: {
        type: 'string',
        description: 'Shell glob pattern. Supports `*`, `?`, `**` (any depth via globstar), `[abc]`, `{a,b,c}`. E.g. "src/**/*.ts" or "*.md". Limited to printable safe chars to prevent shell injection.',
      },
      basePath: {
        type: 'string',
        description: 'Optional working directory to glob from. Defaults to the environment\'s workingDir (or the SSH user\'s home).',
      },
    },
    required: ['environmentId', 'pattern'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GlobArgs>;

    // ── Validation ─────────────────────────────────────────────────────────
    if (!args.environmentId || typeof args.environmentId !== 'string') {
      return validationError('environmentId is required and must be a string');
    }
    if (!args.pattern || typeof args.pattern !== 'string') {
      return validationError('pattern is required and must be a string');
    }
    if (args.pattern.length > 512) {
      return validationError('pattern is too long (>512 chars)');
    }
    if (!GLOB_SAFE_PATTERN.test(args.pattern)) {
      return validationError('pattern contains characters that are not allowed (only printable safe chars + glob meta)');
    }
    if (args.basePath !== undefined && (typeof args.basePath !== 'string' || args.basePath.length === 0)) {
      return validationError('basePath, when provided, must be a non-empty string');
    }

    // ── userId source ──────────────────────────────────────────────────────
    const userId =
      (context?.state as AnyObject | undefined)?.userId
      || (context?.state as AnyObject | undefined)?.data?.userId
      || '';
    if (!userId) {
      return toolError('NO_USER', 'glob requires a userId in graph state — got empty. This usually means the tool was invoked outside a run context.');
    }

    // ── Load + acquire ─────────────────────────────────────────────────────
    let env, sshKey;
    try {
      const resolved = await loadAndResolveEnvironment(args.environmentId, userId);
      env = resolved.env;
      sshKey = resolved.sshKey;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string })?.code || 'ENV_RESOLVE_FAILED';
      return toolError(code, msg, { environmentId: args.environmentId });
    }

    let session;
    try {
      session = await environmentManager.acquire(env, sshKey, userId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError('ENV_ACQUIRE_FAILED', `Failed to acquire environment session: ${msg}`, {
        environmentId: args.environmentId,
      });
    }

    // ── Build the bash glob command ────────────────────────────────────────
    // Pattern is single-quoted so the local shell doesn't expand it. The
    // remote bash gets `printf "%s\n" pattern` with shopt enabling globstar
    // (** recursion), dotglob (hidden files), nullglob (empty list when no
    // match instead of the literal pattern echoing back).
    const quotedPattern = `'${args.pattern.replace(/'/g, `'\\''`)}'`;
    const bashScript = `shopt -s globstar dotglob nullglob; printf "%s\\n" ${quotedPattern}`;
    // Wrap the whole bash script in single quotes for the outer shell.
    const escapedBash = bashScript.replace(/'/g, `'\\''`);
    const command = `bash -c '${escapedBash}'`;

    // ── Exec ────────────────────────────────────────────────────────────────
    let result;
    try {
      result = await session.exec(command, args.basePath ? { cwd: args.basePath } : {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError('GLOB_FAILED', `Glob exec failed: ${msg}`, {
        environmentId: args.environmentId,
        pattern: args.pattern,
      });
    }

    if (result.exitCode !== 0) {
      // Bash returns non-zero only when the script itself fails (syntax,
      // missing bash, etc.). nullglob means no-match is exit 0 with empty
      // stdout. Surface stderr if present.
      return toolError(
        'GLOB_FAILED',
        `Glob command exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
        {
          environmentId: args.environmentId,
          pattern: args.pattern,
          exitCode: result.exitCode,
        },
      );
    }

    // ── Parse stdout into paths ────────────────────────────────────────────
    const allPaths = result.stdout
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const totalRaw = allPaths.length;
    const truncated = totalRaw > MAX_RESULTS;
    const paths = truncated ? allPaths.slice(0, MAX_RESULTS) : allPaths;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          paths,
          total: paths.length,
          totalRaw,
          truncated,
          pattern: args.pattern,
          basePath: args.basePath,
          environmentId: args.environmentId,
        }),
      }],
    };
  },
};

export default globTool;
module.exports = globTool;
