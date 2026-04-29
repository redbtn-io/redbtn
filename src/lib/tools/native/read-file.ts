/**
 * Read File — Native FS Tool (Env Phase C — fs pack)
 *
 * Read a file from a managed Environment via the EnvironmentSession's SFTP
 * channel. Mirrors Claude Code's Read tool semantics: returns content with
 * line-number prefixes (e.g. `42\tconst x = 1`), supports offset + limit
 * to slice a window of lines from a large file, and reports total/truncated
 * info so callers know whether they have the full picture.
 *
 * Spec: ENVIRONMENT-HANDOFF.md §2 Phase C / §4.1
 *   - inputs:  environmentId (required), path (required), offset?, limit?
 *   - output:  { content, lineCount, totalLines, truncated }
 *
 * Implementation:
 *   - Resolves the environment via loadAndResolveEnvironment (same path as
 *     ssh_shell when environmentId is set), then acquires the pooled session.
 *   - Reads the entire file via SFTP (sftpRead returns a Buffer), splits into
 *     lines, slices to the requested window, and prefixes each line with
 *     `${1-indexed lineNumber}\t` so the LLM can cite exact line positions.
 *   - Defaults match the Read tool used by coding agents: offset=0, limit=2000.
 *   - userId source: graph state root (set by buildInitialState) with
 *     defensive fallback to state.data.userId.
 */

import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { environmentManager } from '../../environments/EnvironmentManager';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ReadFileArgs {
  environmentId: string;
  path: string;
  offset?: number;
  limit?: number;
}

const DEFAULT_OFFSET = 0;
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 10_000;

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

const readFileTool: NativeToolDefinition = {
  description:
    'Read a file from a managed Environment via SFTP. Returns content with each line prefixed by its 1-indexed line number and a tab (e.g. "42\\tconst x = 1") so the LLM can cite exact line positions. Supports offset + limit to read a window of lines from large files. Defaults: offset=0, limit=2000 lines. Requires environmentId.',
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
      offset: {
        type: 'integer',
        description: 'Number of lines to skip from the start of the file. Defaults to 0 (read from the top).',
        minimum: 0,
        default: DEFAULT_OFFSET,
      },
      limit: {
        type: 'integer',
        description: `Maximum number of lines to return. Defaults to ${DEFAULT_LIMIT}. Hard cap ${MAX_LIMIT}.`,
        minimum: 1,
        maximum: MAX_LIMIT,
        default: DEFAULT_LIMIT,
      },
    },
    required: ['environmentId', 'path'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ReadFileArgs>;

    // ── Validation ─────────────────────────────────────────────────────────
    if (!args.environmentId || typeof args.environmentId !== 'string') {
      return validationError('environmentId is required and must be a string');
    }
    if (!args.path || typeof args.path !== 'string') {
      return validationError('path is required and must be a string');
    }

    let offset = DEFAULT_OFFSET;
    if (args.offset !== undefined) {
      if (typeof args.offset !== 'number' || !Number.isInteger(args.offset) || args.offset < 0) {
        return validationError('offset must be a non-negative integer');
      }
      offset = args.offset;
    }

    let limit = DEFAULT_LIMIT;
    if (args.limit !== undefined) {
      if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1) {
        return validationError('limit must be a positive integer');
      }
      if (args.limit > MAX_LIMIT) {
        return validationError(`limit must be <= ${MAX_LIMIT}`);
      }
      limit = args.limit;
    }

    // ── userId source — graph state root (canonical), state.data fallback ──
    const userId =
      (context?.state as AnyObject | undefined)?.userId
      || (context?.state as AnyObject | undefined)?.data?.userId
      || '';
    if (!userId) {
      return toolError('NO_USER', 'read_file requires a userId in graph state — got empty. This usually means the tool was invoked outside a run context.');
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

    // ── SFTP read ───────────────────────────────────────────────────────────
    let buffer: Buffer;
    try {
      buffer = await session.sftpRead(args.path);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = /ENOENT|No such file/i.test(msg) ? 'NOT_FOUND' : 'SFTP_READ_FAILED';
      return toolError(code, `Failed to read ${args.path}: ${msg}`, {
        environmentId: args.environmentId,
        path: args.path,
      });
    }

    // ── Slice into the requested line window ───────────────────────────────
    const text = buffer.toString('utf8');
    // Split preserves the trailing newline as an empty trailing element when
    // the file ends with \n — drop it so totalLines reflects the file's real
    // line count rather than text.split('\n').length.
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const totalLines = lines.length;

    const sliceStart = Math.min(offset, totalLines);
    const sliceEnd = Math.min(sliceStart + limit, totalLines);
    const slice = lines.slice(sliceStart, sliceEnd);

    // Prefix each line with its 1-indexed line number + tab. This matches
    // Claude Code's Read tool output format and helps the LLM cite line
    // numbers when proposing edits or referring back to the file.
    const prefixed = slice
      .map((line, idx) => `${sliceStart + idx + 1}\t${line}`)
      .join('\n');

    const lineCount = slice.length;
    const truncated = lineCount < totalLines;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          content: prefixed,
          lineCount,
          totalLines,
          truncated,
          offset: sliceStart,
          limit,
          path: args.path,
          environmentId: args.environmentId,
        }),
      }],
    };
  },
};

export default readFileTool;
module.exports = readFileTool;
