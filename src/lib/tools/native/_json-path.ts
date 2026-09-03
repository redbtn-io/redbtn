/**
 * JSONPath subset — shared helper
 *
 * Filename is prefixed with `_` — see _task-helpers.ts for the convention:
 * this module is a helper, not a registrable native tool.
 *
 * The parser and evaluator here were the private internals of `json-query.ts`
 * until `get_global_state` grew a `path` selector and needed the SAME syntax.
 * Two tools that accept "a JSONPath" must accept exactly the same paths, so the
 * implementation is shared rather than copied.
 *
 * They could not simply be imported from `json-query.ts`: that module ends with
 * `module.exports = jsonQueryTool`, which replaces the CommonJS exports object
 * wholesale, so its `export function parseJsonPath` is present at compile time
 * and GONE at runtime. This module has no such trailer.
 *
 * Supported path syntax (intentionally a subset — covers >99% of agent uses):
 *   $                     → root
 *   .field                → object property
 *   ['field'] / ["field"] → object property (bracket notation; supports keys
 *                           with dots, spaces, quotes, etc.)
 *   [0] / [-1]            → array index (negative counts from end)
 *
 * Out of scope (rejected with a thrown error, never silently ignored):
 *   filters `[?(@.x>1)]`, wildcards `$..foo` / `$.*`, slices `$[1:3]`, scripts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

export type Segment =
  | { kind: 'key'; name: string }
  | { kind: 'index'; idx: number };


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

export function evaluatePath(data: unknown, segments: Segment[]): unknown {
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

/**
 * Resolve a path and report whether it actually landed on something.
 *
 * `evaluatePath` collapses "missing" and "literal null" into `null`, which is
 * fine for `json_query` (its spec says callers must not rely on the
 * distinction) but not for `get_global_state`: "that field does not exist" and
 * "that field is null" are different answers, and a model told the wrong one
 * will invent the difference.
 */
export function resolveJsonPath(
  data: unknown,
  segments: Segment[],
): { found: boolean; value: unknown } {
  let cursor: unknown = data;

  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return { found: false, value: null };

    if (seg.kind === 'key') {
      if (Array.isArray(cursor)) {
        if (seg.name === 'length') {
          cursor = cursor.length;
          continue;
        }
        return { found: false, value: null };
      }
      if (typeof cursor !== 'object') return { found: false, value: null };
      if (!(seg.name in (cursor as AnyObject))) return { found: false, value: null };
      cursor = (cursor as AnyObject)[seg.name];
      continue;
    }

    if (!Array.isArray(cursor)) {
      // Numeric index into an object is valid JS; honour it so `[0]` works on
      // `{ '0': 'a' }` — same tolerance evaluatePath has.
      if (cursor && typeof cursor === 'object') {
        const asKey = String(seg.idx);
        if (!(asKey in (cursor as AnyObject))) return { found: false, value: null };
        cursor = (cursor as AnyObject)[asKey];
        continue;
      }
      return { found: false, value: null };
    }

    const arr = cursor as unknown[];
    const idx = seg.idx < 0 ? arr.length + seg.idx : seg.idx;
    if (idx < 0 || idx >= arr.length) return { found: false, value: null };
    cursor = arr[idx];
  }

  return { found: true, value: cursor === undefined ? null : cursor };
}

/**
 * Render a child accessor onto a base path, so a truncation marker can hand the
 * model the EXACT selector for its next call instead of a description of one.
 */
export function joinJsonPath(base: string, child: string | number): string {
  const root = base && base.trim() ? base.trim() : '$';
  if (typeof child === 'number') return `${root}[${child}]`;
  // Bare identifiers can use dot notation; anything else needs quoting.
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(child)) return `${root}.${child}`;
  return `${root}[${JSON.stringify(child)}]`;
}
