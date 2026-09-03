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

// JSONPath parsing and evaluation live in _json-path.ts — `get_global_state`
// accepts the same `path` syntax and the two tools must not drift apart.
import type { Segment } from './_json-path';
import { parseJsonPath, evaluatePath } from './_json-path';

// Re-exported for source-level compatibility with this helper's original home.
// NOTE: the `module.exports = jsonQueryTool` trailer at the bottom of this file
// replaces the CommonJS exports object, so this named export does NOT survive
// to runtime — require('./_json-path') directly.
export { parseJsonPath };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface JsonQueryArgs {
  data: unknown;
  path: string;
}

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
