/**
 * List Available Tools — Native Meta Tool ("tool tools")
 *
 * Discover the catalogue of native tools that an agent can dynamically invoke
 * via `invoke_tool`. Returns name + description + server for each match —
 * NOT the input schema (use `get_tool_schema` for that to keep the payload
 * small enough to dump into a prompt).
 *
 * Spec: META-PACK-HANDOFF.md §3.1
 *   - inputs:
 *       filter? (string)  — optional case-insensitive substring filter against
 *                           name + description
 *       source? (enum: 'native', default 'native') — only 'native' supported in v1
 *   - output: { tools: [{ name, description, server }], total: number }
 *
 * Behaviour:
 *   - Reads from `getNativeRegistry().listTools()`.
 *   - Strips the meta tools themselves from the result — the agent already
 *     has them wired and doesn't need to discover them recursively.
 *   - Honours `state.toolToolsConfig.{allow, deny}` so denied tools never even
 *     appear in the catalogue (you don't get to know they exist).
 *
 * Pattern matching (no `minimatch` dep):
 *   - `*`  → any chars (`fs_*` matches `fs_read`, `fs_write`)
 *   - `?`  → single char
 *   - All other regex meta-chars are escaped first, THEN `*` and `?` are
 *     translated. The escape order matters — see `matchesPattern` below.
 *   - Deny wins over allow.  When `allow` is set and no pattern matches, the
 *     name is denied.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
  NativeToolInfo,
} from '../native-registry';
import { getNativeRegistry } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ListAvailableToolsArgs {
  filter?: string;
  source?: 'native';
}

export interface ToolToolsConfig {
  allow?: string[];
  deny?: string[];
}

/** The three meta tools always stripped from the listing. */
export const META_TOOL_NAMES: ReadonlySet<string> = new Set([
  'list_available_tools',
  'get_tool_schema',
  'invoke_tool',
]);

/**
 * Convert a glob pattern (`fs_*`, `delete_*`, `task_?`) into an anchored
 * RegExp. The escape order is critical:
 *
 *   1) Escape EVERY regex meta-char in the pattern (including `*` and `?`)
 *      so dots, brackets, parens etc. become literal AND `*`/`?` become `\*`
 *      and `\?` (still inert).
 *   2) Then translate the previously-escaped `\*` → `.*` and `\?` → `.`.
 *
 * If `*` and `?` were not escaped in step 1, the regex would still treat
 * them as literals (since `*` after a non-quantifier-friendly token is just
 * `*` in JS regex source) AND the step-2 translations wouldn't fire because
 * they look for the BACKSLASHED forms — by escaping in step 1 we pin the
 * shape so step 2 can deterministically rewrite them.
 *
 * The character class `[.+^${}()|[\]\\*?]` covers all the characters JS
 * RegExp would otherwise interpret as meta — including `*` and `?` — so the
 * pattern reads cleanly even when authors use weird names.
 */
export function matchesPattern(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
  const regex = new RegExp(
    '^' +
      escaped
        .replace(/\\\*/g, '.*')
        .replace(/\\\?/g, '.') +
      '$',
  );
  return regex.test(name);
}

/**
 * Apply the optional state-supplied allow/deny config to a single tool name.
 * Deny patterns are evaluated FIRST and short-circuit. Allow is evaluated
 * second; if `allow` is non-empty and no pattern matches, the tool is denied.
 * If `config` is undefined or both lists are empty/undefined, all tools are
 * allowed.
 */
export function isAllowed(
  name: string,
  config?: ToolToolsConfig | null,
): boolean {
  if (!config) return true;
  if (Array.isArray(config.deny) && config.deny.some((p) => matchesPattern(name, p))) {
    return false;
  }
  if (
    Array.isArray(config.allow) &&
    config.allow.length > 0 &&
    !config.allow.some((p) => matchesPattern(name, p))
  ) {
    return false;
  }
  return true;
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

/**
 * Read `state.toolToolsConfig` defensively — it may be missing or malformed
 * when the graph hasn't been wired with a meta-pack policy.
 */
function readConfig(state: AnyObject | null | undefined): ToolToolsConfig | null {
  if (!state || typeof state !== 'object') return null;
  const cfg = state.toolToolsConfig;
  if (!cfg || typeof cfg !== 'object') return null;
  const out: ToolToolsConfig = {};
  if (Array.isArray(cfg.allow)) {
    out.allow = cfg.allow.filter((x: unknown): x is string => typeof x === 'string');
  }
  if (Array.isArray(cfg.deny)) {
    out.deny = cfg.deny.filter((x: unknown): x is string => typeof x === 'string');
  }
  if (out.allow === undefined && out.deny === undefined) return null;
  return out;
}

const listAvailableToolsTool: NativeToolDefinition = {
  description:
    'List native tools available for dynamic invocation. Use this to discover tools by capability when you don\'t already know the name. Returns name + description for each match. Use get_tool_schema(name) to see the input shape, then invoke_tool(name, args) to call.',
  server: 'meta',
  inputSchema: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        description:
          'Optional substring filter applied to tool name + description (case-insensitive).',
      },
      source: {
        type: 'string',
        enum: ['native'],
        default: 'native',
        description: 'Tool source. Only \'native\' supported in v1.',
      },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = (rawArgs ?? {}) as Partial<ListAvailableToolsArgs>;

    // Validate filter — string when provided
    let filter: string | null = null;
    if (args.filter !== undefined && args.filter !== null) {
      if (typeof args.filter !== 'string') {
        return validationError('filter must be a string when provided');
      }
      const trimmed = args.filter.trim();
      filter = trimmed.length === 0 ? null : trimmed.toLowerCase();
    }

    // Validate source — only 'native' permitted in v1
    if (args.source !== undefined && args.source !== null) {
      if (typeof args.source !== 'string') {
        return validationError('source must be a string when provided');
      }
      if (args.source !== 'native') {
        return validationError(
          `source must be 'native' (only native tools supported in v1)`,
        );
      }
    }

    const config = readConfig(context?.state);

    try {
      const all: NativeToolInfo[] = getNativeRegistry().listTools();

      const filtered = all.filter((t) => {
        // Drop the meta tools — agents don't need to introspect them
        if (META_TOOL_NAMES.has(t.name)) return false;

        // Apply state-level allow/deny (deny first; deny wins)
        if (!isAllowed(t.name, config)) return false;

        // Apply substring filter against name + description
        if (filter) {
          const hay = (t.name + ' ' + (t.description ?? '')).toLowerCase();
          if (!hay.includes(filter)) return false;
        }
        return true;
      });

      const tools = filtered.map((t) => ({
        name: t.name,
        description: t.description,
        server: t.server,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ tools, total: tools.length }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `list_available_tools failed: ${message}` }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default listAvailableToolsTool;
module.exports = listAvailableToolsTool;
