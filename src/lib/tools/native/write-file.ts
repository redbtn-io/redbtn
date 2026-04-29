/**
 * Write File — Native FS Tool (Env Phase C — fs pack)
 *
 * Write content to a file on a managed Environment via SFTP. Uses the
 * EnvironmentSession.sftpWrite() helper which already does atomic
 * temp-write + rename internally and applies the optional file mode after
 * the rename — so this tool inherits the no-partial-write guarantee for
 * free.
 *
 * Spec: ENVIRONMENT-HANDOFF.md §2 Phase C / §4.1
 *   - inputs:  environmentId (required), path (required), content (required),
 *              mode? (default 0o644)
 *   - output:  { ok: true, bytes }
 *
 * Implementation:
 *   - Resolves the environment (same path as ssh_shell), acquires the pooled
 *     session, calls session.sftpWrite(path, content, { mode }).
 *   - Returns the byte count of the written content (length in UTF-8 bytes
 *     for strings, or buffer length for already-binary input).
 *   - userId source: graph state root, defensive fallback to state.data.
 */

import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { environmentManager } from '../../environments/EnvironmentManager';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface WriteFileArgs {
  environmentId: string;
  path: string;
  content: string;
  mode?: number;
}

const DEFAULT_MODE = 0o644;

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

const writeFileTool: NativeToolDefinition = {
  description:
    'Write content to a file on a managed Environment via SFTP. Atomic — writes to a temp path then renames, so partial writes never corrupt the target. Optionally applies a file mode (default 0o644). Requires environmentId.',
  server: 'fs',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'ID of the managed Environment configured under /api/v1/environments. Required.',
      },
      path: {
        type: 'string',
        description: 'Absolute path to the destination file on the remote machine.',
      },
      content: {
        type: 'string',
        description: 'File content to write (UTF-8 string).',
      },
      mode: {
        type: 'integer',
        description: 'POSIX file mode (e.g. 420 for 0o644, 493 for 0o755). Defaults to 0o644.',
        default: DEFAULT_MODE,
      },
    },
    required: ['environmentId', 'path', 'content'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<WriteFileArgs>;

    // ── Validation ─────────────────────────────────────────────────────────
    if (!args.environmentId || typeof args.environmentId !== 'string') {
      return validationError('environmentId is required and must be a string');
    }
    if (!args.path || typeof args.path !== 'string') {
      return validationError('path is required and must be a string');
    }
    if (typeof args.content !== 'string') {
      return validationError('content is required and must be a string');
    }
    let mode: number = DEFAULT_MODE;
    if (args.mode !== undefined) {
      if (typeof args.mode !== 'number' || !Number.isInteger(args.mode) || args.mode < 0 || args.mode > 0o7777) {
        return validationError('mode must be an integer in the range 0..0o7777');
      }
      mode = args.mode;
    }

    // ── userId source ──────────────────────────────────────────────────────
    const userId =
      (context?.state as AnyObject | undefined)?.userId
      || (context?.state as AnyObject | undefined)?.data?.userId
      || '';
    if (!userId) {
      return toolError('NO_USER', 'write_file requires a userId in graph state — got empty. This usually means the tool was invoked outside a run context.');
    }

    // ── Load + access-check + secret-resolve ────────────────────────────────
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

    // ── Acquire session ─────────────────────────────────────────────────────
    let session;
    try {
      session = await environmentManager.acquire(env, sshKey, userId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError('ENV_ACQUIRE_FAILED', `Failed to acquire environment session: ${msg}`, {
        environmentId: args.environmentId,
      });
    }

    // ── SFTP write (atomic — the session does temp + rename internally) ────
    const bytes = Buffer.byteLength(args.content, 'utf8');
    try {
      await session.sftpWrite(args.path, args.content, { mode });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = /ENOENT|No such file/i.test(msg) ? 'NOT_FOUND' : 'SFTP_WRITE_FAILED';
      return toolError(code, `Failed to write ${args.path}: ${msg}`, {
        environmentId: args.environmentId,
        path: args.path,
      });
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          bytes,
          path: args.path,
          mode,
          environmentId: args.environmentId,
        }),
      }],
    };
  },
};

export default writeFileTool;
module.exports = writeFileTool;
