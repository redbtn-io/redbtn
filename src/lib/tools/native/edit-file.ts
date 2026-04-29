/**
 * Edit File — Native FS Tool (Env Phase C — fs pack)
 *
 * Find-and-replace inside a file on a managed Environment via SFTP. Mirrors
 * Claude Code's Edit tool semantics precisely:
 *
 *   - When `replaceAll: false` (default), `oldString` MUST match exactly once.
 *     If it matches 0 or 2+ times, the tool returns an error WITHOUT touching
 *     the file — the caller must provide more surrounding context to make the
 *     match unique, or pass `replaceAll: true` to opt into multi-replace.
 *   - When `replaceAll: true`, every occurrence of `oldString` is replaced
 *     and the count is returned.
 *   - The write is atomic via the session's temp+rename helper.
 *
 * Spec: ENVIRONMENT-HANDOFF.md §2 Phase C / §4.1 / §4.1 (edit_file semantics)
 *   - inputs:  environmentId (required), path (required), oldString (required),
 *              newString (required), replaceAll? (default false)
 *   - output:  { ok: true, replacements }
 *   - errors:  NO_MATCH (0 hits, replaceAll false)
 *              AMBIGUOUS_MATCH (>1 hits, replaceAll false)
 *
 * Implementation:
 *   - Resolves env, acquires session.
 *   - SFTP-reads the file, counts occurrences of oldString.
 *   - Branches on replaceAll: enforces unique-match-or-reject for false,
 *     replaces all for true.
 *   - SFTP-writes back via the atomic temp+rename helper.
 */

import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { environmentManager } from '../../environments/EnvironmentManager';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface EditFileArgs {
  environmentId: string;
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

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

/**
 * Count non-overlapping occurrences of `needle` in `haystack`. Used to enforce
 * the unique-match-or-reject contract when replaceAll is false. Empty needle
 * is treated as 0 matches (we don't want a "match between every character"
 * scenario to ever happen).
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

/**
 * Replace every occurrence of `needle` with `replacement`. Uses split/join so
 * `replacement` is treated as a literal string (no regex `$&` substitution
 * surprises) and the match count is naturally `parts.length - 1`.
 */
function replaceAllLiteral(haystack: string, needle: string, replacement: string): { result: string; count: number } {
  if (needle.length === 0) return { result: haystack, count: 0 };
  const parts = haystack.split(needle);
  return { result: parts.join(replacement), count: parts.length - 1 };
}

const editFileTool: NativeToolDefinition = {
  description:
    'Find-and-replace inside a file on a managed Environment via SFTP. By default requires `oldString` to match EXACTLY ONCE — if 0 or >1 matches the tool errors out without touching the file. Pass `replaceAll: true` to replace every occurrence. Atomic write via temp+rename. Requires environmentId.',
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
        description: 'Absolute path to the file on the remote machine.',
      },
      oldString: {
        type: 'string',
        description: 'The exact text to find. When replaceAll is false (default) this MUST match exactly once — provide enough surrounding context to make the match unique.',
      },
      newString: {
        type: 'string',
        description: 'The replacement text. Treated as a literal string (no regex substitution).',
      },
      replaceAll: {
        type: 'boolean',
        description: 'When true, replace every occurrence of oldString. When false (default), require oldString to match exactly once or error out.',
        default: false,
      },
    },
    required: ['environmentId', 'path', 'oldString', 'newString'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<EditFileArgs>;

    // ── Validation ─────────────────────────────────────────────────────────
    if (!args.environmentId || typeof args.environmentId !== 'string') {
      return validationError('environmentId is required and must be a string');
    }
    if (!args.path || typeof args.path !== 'string') {
      return validationError('path is required and must be a string');
    }
    if (typeof args.oldString !== 'string' || args.oldString.length === 0) {
      return validationError('oldString is required and must be a non-empty string');
    }
    if (typeof args.newString !== 'string') {
      return validationError('newString is required and must be a string');
    }
    if (args.oldString === args.newString) {
      return validationError('oldString and newString must differ — nothing to do');
    }
    const replaceAll = args.replaceAll === true;

    // ── userId source ──────────────────────────────────────────────────────
    const userId =
      (context?.state as AnyObject | undefined)?.userId
      || (context?.state as AnyObject | undefined)?.data?.userId
      || '';
    if (!userId) {
      return toolError('NO_USER', 'edit_file requires a userId in graph state — got empty. This usually means the tool was invoked outside a run context.');
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

    // ── SFTP read ───────────────────────────────────────────────────────────
    let original: string;
    try {
      const buf = await session.sftpRead(args.path);
      original = buf.toString('utf8');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = /ENOENT|No such file/i.test(msg) ? 'NOT_FOUND' : 'SFTP_READ_FAILED';
      return toolError(code, `Failed to read ${args.path}: ${msg}`, {
        environmentId: args.environmentId,
        path: args.path,
      });
    }

    // ── Apply edit ─────────────────────────────────────────────────────────
    let updated: string;
    let replacements: number;
    if (replaceAll) {
      const r = replaceAllLiteral(original, args.oldString, args.newString);
      updated = r.result;
      replacements = r.count;
      if (replacements === 0) {
        return toolError('NO_MATCH', 'oldString not found in file', {
          environmentId: args.environmentId,
          path: args.path,
          replaceAll: true,
        });
      }
    } else {
      const count = countOccurrences(original, args.oldString);
      if (count === 0) {
        return toolError('NO_MATCH', 'oldString not found in file', {
          environmentId: args.environmentId,
          path: args.path,
        });
      }
      if (count > 1) {
        return toolError(
          'AMBIGUOUS_MATCH',
          `${count} matches found; provide more surrounding context to make the match unique, or set replaceAll:true to replace every occurrence`,
          {
            environmentId: args.environmentId,
            path: args.path,
            matchCount: count,
          },
        );
      }
      // Exactly one match — single-replace via indexOf+slice (avoids any
      // surprise from String.replace's special $& tokens).
      const idx = original.indexOf(args.oldString);
      updated = original.slice(0, idx) + args.newString + original.slice(idx + args.oldString.length);
      replacements = 1;
    }

    // ── SFTP write back (atomic temp+rename via the session) ───────────────
    try {
      await session.sftpWrite(args.path, updated);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError('SFTP_WRITE_FAILED', `Failed to write ${args.path}: ${msg}`, {
        environmentId: args.environmentId,
        path: args.path,
      });
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          replacements,
          path: args.path,
          replaceAll,
          environmentId: args.environmentId,
        }),
      }],
    };
  },
};

export default editFileTool;
module.exports = editFileTool;
