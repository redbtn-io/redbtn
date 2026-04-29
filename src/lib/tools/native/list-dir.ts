/**
 * List Dir — Native FS Tool (Env Phase C — fs pack)
 *
 * Enumerate entries in a directory on a managed Environment. For
 * non-recursive listings the tool uses the EnvironmentSession's SFTP
 * `readdir` (one round-trip, structured stat metadata included). For
 * recursive listings it walks via SFTP with bounded depth and a default
 * ignore set (`.git`, `node_modules`, `.next`, `dist`) so the tool doesn't
 * spin for hours on a sprawling repo.
 *
 * Spec: ENVIRONMENT-HANDOFF.md §2 Phase C / §4.1
 *   - inputs:  environmentId (required), path (required), recursive? (default false),
 *              ignore?: string[], maxEntries? (default 500)
 *   - output:  { entries: [{ name, type, size?, modifiedAt? }] }
 *
 * Implementation:
 *   - Non-recursive: single sftpReaddir call. Map each entry to
 *     { name, type, size, modifiedAt } using the discriminator the session
 *     already produces.
 *   - Recursive: BFS walk with maxEntries cap. Each subdir traversal also
 *     uses sftpReaddir. Names matching any default-or-user ignore pattern
 *     skip both inclusion AND descent.
 *   - Ignore patterns are matched as plain strings against the basename of
 *     each entry (NOT the full path). A simple equals-check covers the
 *     usual `.git`, `node_modules`, etc. without needing a full glob engine.
 *   - Recursive output paths are joined with `/` from the supplied root, so
 *     callers see them relative to the root they asked about.
 */

import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { environmentManager } from '../../environments/EnvironmentManager';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ListDirArgs {
  environmentId: string;
  path: string;
  recursive?: boolean;
  ignore?: string[];
  maxEntries?: number;
}

interface DirEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  modifiedAt: string;
}

const DEFAULT_MAX_ENTRIES = 500;
const MAX_MAX_ENTRIES = 5000;
const DEFAULT_IGNORE = ['.git', 'node_modules', '.next', 'dist'];
const MAX_RECURSE_DEPTH = 16;

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

const listDirTool: NativeToolDefinition = {
  description:
    'List directory entries on a managed Environment via SFTP. Returns name, type (file/dir/link/other), size, and modifiedAt for each entry. Recursive mode walks subdirectories with sane defaults (.git/node_modules/.next/dist ignored). Capped at maxEntries (default 500). Requires environmentId.',
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
        description: 'Absolute path to the directory on the remote machine.',
      },
      recursive: {
        type: 'boolean',
        description: 'When true, walks subdirectories. Default false (single-level listing).',
        default: false,
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: `Names to skip (matched against entry basename). Adds to the default skip list: ${DEFAULT_IGNORE.join(', ')}.`,
      },
      maxEntries: {
        type: 'integer',
        description: `Cap on total entries returned. Defaults to ${DEFAULT_MAX_ENTRIES}. Hard cap ${MAX_MAX_ENTRIES}.`,
        minimum: 1,
        maximum: MAX_MAX_ENTRIES,
        default: DEFAULT_MAX_ENTRIES,
      },
    },
    required: ['environmentId', 'path'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ListDirArgs>;

    // ── Validation ─────────────────────────────────────────────────────────
    if (!args.environmentId || typeof args.environmentId !== 'string') {
      return validationError('environmentId is required and must be a string');
    }
    if (!args.path || typeof args.path !== 'string') {
      return validationError('path is required and must be a string');
    }
    const recursive = args.recursive === true;
    if (args.ignore !== undefined) {
      if (!Array.isArray(args.ignore) || !args.ignore.every((p) => typeof p === 'string')) {
        return validationError('ignore must be an array of strings');
      }
    }
    let maxEntries = DEFAULT_MAX_ENTRIES;
    if (args.maxEntries !== undefined) {
      if (typeof args.maxEntries !== 'number' || !Number.isInteger(args.maxEntries) || args.maxEntries < 1 || args.maxEntries > MAX_MAX_ENTRIES) {
        return validationError(`maxEntries must be an integer in 1..${MAX_MAX_ENTRIES}`);
      }
      maxEntries = args.maxEntries;
    }

    const ignoreSet = new Set<string>([...DEFAULT_IGNORE, ...(args.ignore ?? [])]);

    // ── userId source ──────────────────────────────────────────────────────
    const userId =
      (context?.state as AnyObject | undefined)?.userId
      || (context?.state as AnyObject | undefined)?.data?.userId
      || '';
    if (!userId) {
      return toolError('NO_USER', 'list_dir requires a userId in graph state — got empty. This usually means the tool was invoked outside a run context.');
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

    // ── Read entries ───────────────────────────────────────────────────────
    const entries: DirEntry[] = [];
    let truncated = false;

    /**
     * Read one directory level via SFTP. Catches ENOENT for graceful errors.
     */
    const readLevel = async (dir: string): Promise<{ name: string; type: 'file' | 'dir' | 'link' | 'other'; size: number; modifiedAt: Date }[]> => {
      try {
        return await session.sftpReaddir(dir);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw Object.assign(new Error(`Failed to read directory ${dir}: ${msg}`), {
          code: /ENOENT|No such file/i.test(msg) ? 'NOT_FOUND' : 'SFTP_READDIR_FAILED',
        });
      }
    };

    if (!recursive) {
      // Single-level: flat readdir. Apply ignore filter but keep ordering as
      // the server returned it (alphabetical on most servers).
      let raw;
      try {
        raw = await readLevel(args.path);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string })?.code || 'SFTP_READDIR_FAILED';
        return toolError(code, msg, { environmentId: args.environmentId, path: args.path });
      }
      for (const e of raw) {
        if (ignoreSet.has(e.name)) continue;
        entries.push({
          name: e.name,
          type: e.type,
          size: e.size,
          modifiedAt: e.modifiedAt.toISOString(),
        });
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
      }
    } else {
      // Recursive: BFS walk. The queue holds (dirRelativeToRoot, depth) pairs.
      // We always include directories themselves in the output (so callers
      // can distinguish empty dirs from files), then enqueue them for further
      // walk if depth allows.
      const queue: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];
      while (queue.length > 0) {
        const { rel, depth } = queue.shift()!;
        const fullDir = rel === '' ? args.path : `${args.path.replace(/\/+$/, '')}/${rel}`;
        let raw;
        try {
          raw = await readLevel(fullDir);
        } catch (err: unknown) {
          // For the root, propagate as a tool error — the user gave us a bad
          // path. For sub-dirs, log and continue (one bad sub-dir shouldn't
          // abort the whole walk).
          if (rel === '') {
            const msg = err instanceof Error ? err.message : String(err);
            const code = (err as { code?: string })?.code || 'SFTP_READDIR_FAILED';
            return toolError(code, msg, { environmentId: args.environmentId, path: args.path });
          }
          continue;
        }
        for (const e of raw) {
          if (ignoreSet.has(e.name)) continue;
          const relPath = rel === '' ? e.name : `${rel}/${e.name}`;
          entries.push({
            name: relPath,
            type: e.type,
            size: e.size,
            modifiedAt: e.modifiedAt.toISOString(),
          });
          if (entries.length >= maxEntries) {
            truncated = true;
            break;
          }
          if (e.type === 'dir' && depth + 1 < MAX_RECURSE_DEPTH) {
            queue.push({ rel: relPath, depth: depth + 1 });
          }
        }
        if (truncated) break;
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          entries,
          total: entries.length,
          truncated,
          path: args.path,
          recursive,
          environmentId: args.environmentId,
        }),
      }],
    };
  },
};

export default listDirTool;
module.exports = listDirTool;
