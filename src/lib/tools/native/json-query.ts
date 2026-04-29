/**
 * JSON Query — Native Pattern Tool
 *
 * Resolve a JSONPath-style expression against an arbitrary JSON value.
 * Pure utility — no API calls, no side effects.
 *
 * Spec: TOOL-HANDOFF.md §4.6
 *   - inputs: data (required, any JSON-serialisable value),
 *             path (required, string — JSONPath, e.g. `$.users[0].name`)
 *   - output: { value: any | null }
 *
 * Supported path syntax (intentionally a subset — covers >99% of agent uses):
 *   $                     → root
 *   .field                → object property
 *   ['field']             → object property (bracket notation; supports keys
 *                           with dots, spaces, quotes, etc.)
 *   ["field"]             → object property (double-quoted)
 *   [0] / [-1]            → array index (negative counts from end)
 *
 * Out of scope (not supported — the underlying engine helpers don't either):
 *   - filter expressions      (`$.items[?(@.price>10)]`)
 *   - wildcards / recursive   (`$..foo`, `$.*`)
 *   - slicing                 (`$[1:3]`)
 *   - script expressions
 *
 * Implementation notes:
 *   - The parser is allowlist-based; any unsupported token returns a
 *     VALIDATION error rather than silently returning null.
 *   - When the path resolves successfully but the value is `undefined`
 *     (e.g. accessing a missing key or out-of-range index), we return
 *     `{ value: null }` per the spec.
 *   - When the path resolves to literal `null`, we return `{ value: null }`
 *     as well — callers should not rely on null vs missing distinction.
 *   - The leading `$` is optional; `users[0].name` is treated the same as
 *     `$.users[0].name`. A leading dot on a top-level field (`.users`) is
 *     also tolerated.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface JsonQueryArgs {
  data: unknown;
  path: string;
}

type Segment =
  | { kind: 'key'; name: string }
  | { kind: 'index'; idx: number };

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

/**
 * Tokenise a JSONPath expression into a sequence of property accesses and
 * array indexes. Throws on unsupported syntax so the caller can return a
 * structured VALIDATION error.
 */
export function parseJsonPath(rawPath: string): Segment[] {
  let path = rawPath.trim();

  // Strip leading `$`
  if (path.startsWith('$')) path = path.slice(1);

  // Recursive descent (`..foo`) is intentionally not supported. Detect and
  // reject before the outer loop strips the leading dot.
  if (path.startsWith('..')) {
    throw new Error(
      'Recursive descent (".." / "$..") is not supported by this JSONPath subset',
    );
  }

  // Strip a single leading `.` (treats `.foo` and `$.foo` and `foo` the same)
  if (path.startsWith('.')) path = path.slice(1);

  if (path.length === 0) return [];

  const segments: Segment[] = [];
  let i = 0;
  const len = path.length;

  while (i < len) {
    const ch = path[i];

    if (ch === '.') {
      // dotted property name follows
      i++;
      if (i >= len) throw new Error('Unexpected end of path after "."');
      // Reject mid-path recursive descent: `$.foo..bar`
      if (path[i] === '.') {
        throw new Error(
          'Recursive descent ("..") is not supported by this JSONPath subset',
        );
      }
      const start = i;
      while (i < len && path[i] !== '.' && path[i] !== '[') i++;
      const name = path.slice(start, i);
      if (!name) throw new Error('Empty property name after "."');
      segments.push({ kind: 'key', name });
      continue;
    }

    if (ch === '[') {
      // bracket — either ['key'] / ["key"] or [0]
      i++;
      if (i >= len) throw new Error('Unclosed bracket "["');
      const inner = path[i];

      if (inner === "'" || inner === '"') {
        const quote = inner;
        i++;
        let buf = '';
        while (i < len && path[i] !== quote) {
          // Allow simple backslash escapes: \\ \\' \\" \\n \\t
          if (path[i] === '\\' && i + 1 < len) {
            const next = path[i + 1];
            if (next === '\\' || next === quote) {
              buf += next;
              i += 2;
              continue;
            }
            if (next === 'n') { buf += '\n'; i += 2; continue; }
            if (next === 't') { buf += '\t'; i += 2; continue; }
          }
          buf += path[i];
          i++;
        }
        if (i >= len) throw new Error(`Unclosed quoted key: missing ${quote}`);
        i++; // consume closing quote
        if (i >= len || path[i] !== ']') {
          throw new Error('Expected "]" after quoted key');
        }
        i++; // consume ]
        segments.push({ kind: 'key', name: buf });
        continue;
      }

      // numeric index (possibly negative)
      const start = i;
      if (path[i] === '-') i++;
      while (i < len && path[i] >= '0' && path[i] <= '9') i++;
      const numText = path.slice(start, i);
      if (!numText || numText === '-') {
        throw new Error('Expected number, quoted key, or wildcard inside [...]');
      }
      if (i >= len || path[i] !== ']') {
        // Likely a wildcard / filter / slice — explicitly unsupported
        throw new Error(
          `Unsupported bracket expression: "[${path.slice(start, Math.min(i + 1, len))}...]"`,
        );
      }
      i++; // consume ]
      const idx = parseInt(numText, 10);
      if (!Number.isFinite(idx)) {
        throw new Error(`Invalid array index: "${numText}"`);
      }
      segments.push({ kind: 'index', idx });
      continue;
    }

    // Bare identifier at start (no leading dot/bracket — already handled above)
    const start = i;
    while (i < len && path[i] !== '.' && path[i] !== '[') i++;
    const name = path.slice(start, i);
    if (!name) throw new Error(`Unexpected character "${ch}" in path`);
    segments.push({ kind: 'key', name });
  }

  return segments;
}

function evaluatePath(data: unknown, segments: Segment[]): unknown {
  let cursor: unknown = data;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return null;

    if (seg.kind === 'key') {
      if (typeof cursor !== 'object' || Array.isArray(cursor)) {
        // Array property access by key (e.g. `length`) is allowed
        if (Array.isArray(cursor) && seg.name === 'length') {
          cursor = cursor.length;
          continue;
        }
        return null;
      }
      cursor = (cursor as AnyObject)[seg.name];
      continue;
    }

    // index
    if (!Array.isArray(cursor)) {
      // Indexing into an object with a numeric key is also valid in JS;
      // honour it so `data[0]` works on `{ '0': 'a' }`.
      if (cursor && typeof cursor === 'object') {
        cursor = (cursor as AnyObject)[String(seg.idx)];
        continue;
      }
      return null;
    }
    const arr = cursor as unknown[];
    const idx = seg.idx < 0 ? arr.length + seg.idx : seg.idx;
    if (idx < 0 || idx >= arr.length) return null;
    cursor = arr[idx];
  }

  return cursor === undefined ? null : cursor;
}

const jsonQueryTool: NativeToolDefinition = {
  description:
    'Evaluate a JSONPath-style expression against a JSON value. Use to extract a nested field without writing custom traversal code. Supports dot, bracket, quoted keys, and negative indexes (e.g. `$.users[0].name`, `$["full name"]`, `$.items[-1]`).',
  server: 'pattern',
  inputSchema: {
    type: 'object',
    properties: {
      data: {
        description:
          'The JSON value to query. Can be any JSON-serialisable type (object, array, primitive).',
      },
      path: {
        type: 'string',
        description:
          'JSONPath expression. Supported: $, .field, ["field"], [N], [-N]. Wildcards, filters, and slices are not supported.',
      },
    },
    required: ['data', 'path'],
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<JsonQueryArgs>;

    if (!('data' in (rawArgs || {}))) {
      return validationError('data is required');
    }
    if (typeof args.path !== 'string' || args.path.length === 0) {
      return validationError('path is required and must be a non-empty string');
    }

    let segments: Segment[];
    try {
      segments = parseJsonPath(args.path);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return validationError(`Invalid JSONPath: ${message}`);
    }

    try {
      const value = evaluatePath(args.data, segments);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ value: value === undefined ? null : value }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `JSONPath evaluation failed: ${message}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default jsonQueryTool;
module.exports = jsonQueryTool;
