/**
 * `toolsFrom` path parsing — dependency-free on purpose.
 *
 * Shared by the executor (executors/toolsFrom.ts) and by
 * `validateGraphConfig`, which the webapp `require`s directly and must stay
 * light (no tool registry, no Mongo, no Redis on its import graph).
 *
 * See executors/toolsFrom.ts for the full `toolsFrom` contract.
 */

/**
 * Whether `path` is a plain dot path: one or more non-empty segments joined
 * by `.`, with no whitespace and no template braces.
 */
export function isDotPath(path: string): boolean {
  return /^[^.\s{}]+(\.[^.\s{}]+)*$/.test(path);
}

function describeRaw(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Normalise a step's `toolsFrom` value into a dot path relative to run state.
 *
 *   - `undefined` / `null` / empty or whitespace-only string -> `{ path: null }` (absent)
 *   - a leading `state.` is stripped (`"state.data.x"` == `"data.x"`)
 *   - anything else that is not a plain dot path -> `{ path: null, error }`
 */
export function normaliseToolsFromPath(raw: unknown): { path: string | null; error?: string } {
  if (raw === undefined || raw === null) return { path: null };
  if (typeof raw !== 'string') {
    return {
      path: null,
      error: `toolsFrom must be a string dot path into run state (e.g. "data.opTools"), got ${describeRaw(raw)}`,
    };
  }
  let path = raw.trim();
  if (path === '') return { path: null };
  if (path.startsWith('state.')) path = path.slice('state.'.length);
  if (!isDotPath(path)) {
    return {
      path: null,
      error:
        `toolsFrom "${raw}" is not a dot path into run state (e.g. "data.opTools"): ` +
        'segments separated by ".", no spaces, no {{templates}}',
    };
  }
  return { path };
}
