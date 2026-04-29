/**
 * Grep Files — Native FS Tool (Env Phase C — fs pack)
 *
 * Search file contents for a regex pattern across files on a managed
 * Environment. Prefers ripgrep (`rg`) for speed and structured JSON output;
 * falls back to `grep -rn` when ripgrep isn't installed (parses the
 * `path:line:content` format instead).
 *
 * Spec: ENVIRONMENT-HANDOFF.md §2 Phase C / §4.1
 *   - inputs:  environmentId (required), pattern (required), path?,
 *              contextLines? (default 0), maxResults? (default 100)
 *   - output:  { matches: [{ file, line, content, context? }] }
 *
 * Implementation:
 *   - One probe SSH call: `command -v rg`. If present, run rg with
 *     `--json --no-heading --line-number` and parse line-delimited JSON. If
 *     not, fall back to `grep -rn -E -H` (recursive + line-number + extended-
 *     regex + always show filename) and parse `<file>:<line>:<content>`.
 *   - `contextLines` maps to `-A N -B N` for grep (or `--context N` for rg).
 *   - `maxResults` caps the count both at the rg/grep level (`-m`) and after
 *     parse for safety.
 */

import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { environmentManager } from '../../environments/EnvironmentManager';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GrepFilesArgs {
  environmentId: string;
  pattern: string;
  path?: string;
  contextLines?: number;
  maxResults?: number;
}

interface GrepMatch {
  file: string;
  line: number;
  content: string;
  context?: string[];
}

const DEFAULT_CONTEXT_LINES = 0;
const DEFAULT_MAX_RESULTS = 100;
const MAX_MAX_RESULTS = 1000;

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
 * Quote a string for safe interpolation inside single-quoted bash. We close
 * the surrounding quote, insert the literal `'`, and reopen — a standard
 * shell idiom: `'foo'\''bar'` produces `foo'bar`.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse `rg --json` line-delimited output into our match shape. Each line is a
 * JSON object with `type` discriminator; we only care about `type:"match"`
 * (and optionally `type:"context"` when contextLines > 0).
 */
function parseRgJson(stdout: string, contextLines: number, maxResults: number): GrepMatch[] {
  const matches: GrepMatch[] = [];
  // Buffered context lines per file — we accumulate them and attach when we
  // see the next match for the same file.
  let lastMatch: GrepMatch | null = null;
  let lastFile = '';
  let pendingContextBefore: string[] = [];

  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    let entry: AnyObject;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    const type = entry.type;
    if (type === 'begin') {
      lastFile = entry.data?.path?.text || lastFile;
      pendingContextBefore = [];
      continue;
    }
    if (type === 'context' && contextLines > 0) {
      const text = entry.data?.lines?.text;
      if (typeof text === 'string') {
        // Strip trailing newline rg includes
        const cleaned = text.replace(/\n$/, '');
        if (lastMatch) {
          if (!lastMatch.context) lastMatch.context = [];
          lastMatch.context.push(cleaned);
        } else {
          pendingContextBefore.push(cleaned);
        }
      }
      continue;
    }
    if (type === 'match') {
      const file = entry.data?.path?.text || lastFile || '';
      const lineNumber = typeof entry.data?.line_number === 'number' ? entry.data.line_number : 0;
      const text = entry.data?.lines?.text;
      const content = typeof text === 'string' ? text.replace(/\n$/, '') : '';
      const m: GrepMatch = { file, line: lineNumber, content };
      if (contextLines > 0 && pendingContextBefore.length > 0) {
        m.context = [...pendingContextBefore];
        pendingContextBefore = [];
      }
      matches.push(m);
      lastMatch = m;
      if (matches.length >= maxResults) break;
      continue;
    }
    if (type === 'end') {
      lastMatch = null;
      pendingContextBefore = [];
    }
  }
  return matches;
}

/**
 * Parse `grep -rn -H` output into our match shape. Each match line is
 * `<file>:<line>:<content>`. Context lines (when -A/-B is used) appear with
 * `<file>-<line>-<content>` (note the dash separator) and are interleaved
 * with `--` group separators between matches.
 */
function parseGrepOutput(stdout: string, contextLines: number, maxResults: number): GrepMatch[] {
  const matches: GrepMatch[] = [];
  // grep separates groups with a literal `--` line when context is enabled.
  const groups = contextLines > 0 ? stdout.split(/^--$/m) : [stdout];
  for (const group of groups) {
    const lines = group.split('\n').filter((l) => l.length > 0);
    const groupMatches: GrepMatch[] = [];
    let groupContext: string[] = [];
    for (const line of lines) {
      // Match line: file:line:content. Use a non-greedy match on the file +
      // line then take the rest as content (so colons in content are kept).
      const matchRe = /^([^:]+):(\d+):(.*)$/;
      const ctxRe = /^([^:]+)-(\d+)-(.*)$/;
      let m = matchRe.exec(line);
      let isMatch = true;
      if (!m && contextLines > 0) {
        m = ctxRe.exec(line);
        isMatch = false;
      }
      if (!m) continue;
      const file = m[1];
      const lineNumber = parseInt(m[2], 10);
      const content = m[3];
      if (isMatch) {
        const entry: GrepMatch = { file, line: lineNumber, content };
        if (contextLines > 0) {
          if (groupContext.length > 0) {
            entry.context = [...groupContext];
            groupContext = [];
          }
        }
        groupMatches.push(entry);
      } else if (contextLines > 0) {
        // Context line — attach to the most recent match in the group, or
        // buffer until the first match arrives.
        if (groupMatches.length > 0) {
          const last = groupMatches[groupMatches.length - 1];
          if (!last.context) last.context = [];
          last.context.push(content);
        } else {
          groupContext.push(content);
        }
      }
    }
    for (const m of groupMatches) {
      if (matches.length >= maxResults) break;
      matches.push(m);
    }
    if (matches.length >= maxResults) break;
  }
  return matches.slice(0, maxResults);
}

const grepFilesTool: NativeToolDefinition = {
  description:
    'Search file contents on a managed Environment for a regex pattern. Uses ripgrep when available (much faster) and falls back to grep -rn. Returns up to maxResults matches with optional surrounding context lines. Requires environmentId.',
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
        description: 'Regex pattern to search for (PCRE-style for ripgrep; POSIX extended for grep fallback). E.g. "TODO|FIXME" or "function\\s+\\w+".',
      },
      path: {
        type: 'string',
        description: 'Optional file or directory to search within. Defaults to the environment\'s workingDir.',
      },
      contextLines: {
        type: 'integer',
        description: `Number of context lines to include before AND after each match. Defaults to ${DEFAULT_CONTEXT_LINES} (no context).`,
        minimum: 0,
        maximum: 50,
        default: DEFAULT_CONTEXT_LINES,
      },
      maxResults: {
        type: 'integer',
        description: `Maximum number of matches to return. Defaults to ${DEFAULT_MAX_RESULTS}. Hard cap ${MAX_MAX_RESULTS}.`,
        minimum: 1,
        maximum: MAX_MAX_RESULTS,
        default: DEFAULT_MAX_RESULTS,
      },
    },
    required: ['environmentId', 'pattern'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GrepFilesArgs>;

    // ── Validation ─────────────────────────────────────────────────────────
    if (!args.environmentId || typeof args.environmentId !== 'string') {
      return validationError('environmentId is required and must be a string');
    }
    if (!args.pattern || typeof args.pattern !== 'string') {
      return validationError('pattern is required and must be a string');
    }
    if (args.pattern.length > 1024) {
      return validationError('pattern is too long (>1024 chars)');
    }
    if (args.path !== undefined && (typeof args.path !== 'string' || args.path.length === 0)) {
      return validationError('path, when provided, must be a non-empty string');
    }
    let contextLines = DEFAULT_CONTEXT_LINES;
    if (args.contextLines !== undefined) {
      if (typeof args.contextLines !== 'number' || !Number.isInteger(args.contextLines) || args.contextLines < 0 || args.contextLines > 50) {
        return validationError('contextLines must be an integer in 0..50');
      }
      contextLines = args.contextLines;
    }
    let maxResults = DEFAULT_MAX_RESULTS;
    if (args.maxResults !== undefined) {
      if (typeof args.maxResults !== 'number' || !Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > MAX_MAX_RESULTS) {
        return validationError(`maxResults must be an integer in 1..${MAX_MAX_RESULTS}`);
      }
      maxResults = args.maxResults;
    }

    // ── userId source ──────────────────────────────────────────────────────
    const userId =
      (context?.state as AnyObject | undefined)?.userId
      || (context?.state as AnyObject | undefined)?.data?.userId
      || '';
    if (!userId) {
      return toolError('NO_USER', 'grep_files requires a userId in graph state — got empty. This usually means the tool was invoked outside a run context.');
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

    // ── Probe for ripgrep ──────────────────────────────────────────────────
    let useRg = false;
    try {
      const probe = await session.exec('command -v rg', {});
      useRg = probe.exitCode === 0 && probe.stdout.trim().length > 0;
    } catch {
      useRg = false;
    }

    // ── Build the search command ───────────────────────────────────────────
    const target = args.path ?? '.';
    const quotedPattern = shellQuote(args.pattern);
    const quotedTarget = shellQuote(target);

    let command: string;
    if (useRg) {
      // ripgrep with structured output. --no-heading keeps the JSON event
      // stream uniform; --line-number is implicit in --json but explicit
      // for clarity. -m maxResults bounds the work rg does.
      const ctxFlag = contextLines > 0 ? `--context ${contextLines} ` : '';
      command = `rg --json --line-number --no-heading -m ${maxResults} ${ctxFlag}-e ${quotedPattern} ${quotedTarget}`;
    } else {
      // grep fallback: -r recursive, -n line numbers, -H always print
      // filename, -E extended regex, -m max-count per file (we apply the
      // global cap during parse). Context flags only emitted when needed.
      const ctxFlag = contextLines > 0 ? `-A ${contextLines} -B ${contextLines} ` : '';
      command = `grep -r -n -H -E -m ${maxResults} ${ctxFlag}-e ${quotedPattern} ${quotedTarget}`;
    }

    // ── Exec ────────────────────────────────────────────────────────────────
    let result;
    try {
      result = await session.exec(command, {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError('GREP_FAILED', `Search exec failed: ${msg}`, {
        environmentId: args.environmentId,
        pattern: args.pattern,
        engine: useRg ? 'rg' : 'grep',
      });
    }

    // grep returns exit code 1 when there are no matches — that's not an
    // error, just an empty result. rg returns 1 likewise. Anything ≥2 is a
    // real failure.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return toolError(
        'GREP_FAILED',
        `Search command exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
        {
          environmentId: args.environmentId,
          pattern: args.pattern,
          exitCode: result.exitCode,
          engine: useRg ? 'rg' : 'grep',
        },
      );
    }

    // ── Parse output ───────────────────────────────────────────────────────
    const matches = useRg
      ? parseRgJson(result.stdout, contextLines, maxResults)
      : parseGrepOutput(result.stdout, contextLines, maxResults);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          matches,
          total: matches.length,
          truncated: matches.length >= maxResults,
          pattern: args.pattern,
          path: target,
          engine: useRg ? 'rg' : 'grep',
          environmentId: args.environmentId,
        }),
      }],
    };
  },
};

export default grepFilesTool;
module.exports = grepFilesTool;
