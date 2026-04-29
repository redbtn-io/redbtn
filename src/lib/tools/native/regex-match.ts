/**
 * Regex Match — Native Pattern Tool
 *
 * Runs a regular expression against `text` and returns the match(es).
 * Pure utility — no API calls, no side effects.
 *
 * Spec: TOOL-HANDOFF.md §4.6
 *   - inputs: text (required, string),
 *             pattern (required, string — regex source),
 *             flags? (string — regex flags, e.g. "gi"; default ''),
 *             mode? ('first' | 'all' — default 'first')
 *   - output: { matches: [{ match: string, groups: any, index: number }] }
 *
 * Notes:
 *   - In `mode: 'first'` the result has 0 or 1 entries.
 *   - In `mode: 'all'` the result has every non-overlapping match. We always
 *     ensure the regex carries the `g` flag in this mode (auto-added if the
 *     caller forgot it) so `matchAll` works.
 *   - `groups` is the **named** groups object (`match.groups`) when present,
 *     otherwise an array of the positional capture groups (without the full
 *     match). We never return `null` for `groups` — `{}` or `[]` is friendlier
 *     for downstream graph-state consumers.
 *   - We refuse to invoke a pathological regex by enforcing a soft cap on
 *     iterations in `mode: 'all'` (10k matches), to keep zero-width matches
 *     and catastrophic patterns from looping forever.
 *   - Malformed regex / unknown flag → `isError: true` + `code: 'VALIDATION'`.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface RegexMatchArgs {
  text: string;
  pattern: string;
  flags?: string;
  mode?: 'first' | 'all';
}

interface RegexMatchResult {
  match: string;
  groups: Record<string, string | undefined> | (string | undefined)[];
  index: number;
}

const MAX_ALL_MATCHES = 10_000;

function validationError(message: string): NativeMcpResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message, code: 'VALIDATION' }),
      },
    ],
    isError: true,
  };
}

function buildResult(m: RegExpMatchArray | RegExpExecArray): RegexMatchResult {
  const matchText = m[0] ?? '';
  // Prefer named groups when the pattern provides them; otherwise return the
  // positional captures (excluding match[0]). Always return *something*.
  const named = (m as RegExpMatchArray).groups;
  const groups =
    named && typeof named === 'object'
      ? { ...named }
      : (m.length > 1 ? Array.from(m).slice(1) : []);
  return {
    match: matchText,
    groups: groups as RegexMatchResult['groups'],
    index: typeof m.index === 'number' ? m.index : -1,
  };
}

const regexMatchTool: NativeToolDefinition = {
  description:
    'Run a regular expression against text and return the matches. Use to extract structured fragments (IDs, dates, URLs, etc.) from free-form text. Set mode: "all" to capture every non-overlapping hit; default "first" returns only the first one.',
  server: 'pattern',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The input text to search.',
      },
      pattern: {
        type: 'string',
        description:
          'The regex source (without surrounding `/` delimiters). Example: "\\\\b\\\\d{4}-\\\\d{2}-\\\\d{2}\\\\b" for ISO dates.',
      },
      flags: {
        type: 'string',
        description:
          'Optional regex flags (e.g. "i", "gi", "ms"). Empty by default. The "g" flag is auto-added when mode is "all".',
        default: '',
      },
      mode: {
        type: 'string',
        enum: ['first', 'all'],
        description:
          'Match mode. "first" returns the single first match (or empty array). "all" returns every non-overlapping match.',
        default: 'first',
      },
    },
    required: ['text', 'pattern'],
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<RegexMatchArgs>;

    if (typeof args.text !== 'string') {
      return validationError('text is required and must be a string');
    }
    if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
      return validationError('pattern is required and must be a non-empty string');
    }
    if (args.flags !== undefined && typeof args.flags !== 'string') {
      return validationError('flags must be a string when provided');
    }
    const mode = args.mode === 'all' ? 'all' : 'first';

    let flags = args.flags ?? '';
    if (mode === 'all' && !flags.includes('g')) {
      flags += 'g';
    }

    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, flags);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return validationError(`Invalid regex: ${message}`);
    }

    try {
      const matches: RegexMatchResult[] = [];

      if (mode === 'first') {
        // Use a non-global regex for single-shot match so .index is reliable.
        // If caller provided 'g' flag, strip it for `.match()` semantics.
        const firstFlags = flags.replace(/g/g, '');
        const firstRegex = new RegExp(args.pattern, firstFlags);
        const m = args.text.match(firstRegex);
        if (m) matches.push(buildResult(m));
      } else {
        // mode === 'all'
        let count = 0;
        for (const m of args.text.matchAll(regex)) {
          matches.push(buildResult(m));
          count++;
          if (count >= MAX_ALL_MATCHES) break;
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ matches }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Regex execution failed: ${message}` }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default regexMatchTool;
module.exports = regexMatchTool;
