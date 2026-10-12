/**
 * Runtime tool lists for neuron steps — `toolsFrom`.
 *
 * A neuron step's `tools` is a literal array fixed at authoring time. Some
 * graphs (redOps operators, loop supervisors) need the tool roster to come
 * from the run instead: a set step computes it, or the trigger supplies it.
 * `toolsFrom` names where in run state to find that list.
 *
 * CONTRACT (other agents build against this — keep it exact):
 *   - `toolsFrom` is an optional dot path into run state, e.g. `"data.opTools"`.
 *     A leading `state.` is accepted and ignored. An empty / whitespace-only
 *     string is treated as absent.
 *   - At execution the value at that path, when it is an ARRAY of ToolRefs
 *     (the same shapes `tools` accepts: `'get_global_state'`, `'mcp:...'`,
 *     `'mcp:<server>.<tool>'`, `'graph:...'`, `'hosted:...'`, or
 *     `{ name, source }` objects), is appended AFTER the literal
 *     `config.tools`, de-duplicated by ref identity ({@link toolRefKey}).
 *   - A missing value or a non-array is ignored with a warning in the run
 *     log, never an error. Malformed entries inside the array are skipped
 *     the same way. The literal `tools` are never touched.
 *   - Strings are taken literally — no template rendering.
 *   - Nothing here grants anything: the merged list goes through the same
 *     resolver, capability grants and CLI run bridge as literal `tools`,
 *     because the executor simply runs the step with `tools` = merged list.
 *
 * This module is pure (no I/O) so it can be unit-tested in isolation; the
 * executor does the logging.
 *
 * @module lib/nodes/universal/executors/toolsFrom
 */

import type { NeuronStepConfig, ToolRef } from '../types';
import { isToolRefShape, toolRefKey } from '../../../tools/tool-resolver';
import { normaliseToolsFromPath } from '../toolsFromPath';

export { normaliseToolsFromPath, isDotPath } from '../toolsFromPath';

/** Result of resolving a step's `toolsFrom`. */
export interface ToolsFromResolution {
  /**
   * The normalised path that was read (leading `state.` stripped), or null
   * when the step has no usable `toolsFrom`.
   */
  path: string | null;
  /** Effective tool list: the literal `tools` first, then the new runtime refs. */
  tools: ToolRef[];
  /** Runtime refs that were appended (after de-duplication), in order. */
  added: ToolRef[];
  /** Runtime refs dropped because the same ref was already in the list. */
  duplicates: number;
  /** Human-readable reasons something was ignored. Never fatal. */
  warnings: string[];
}

/** Read a dot path from an object, the way templates read `state.*`. */
function readPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a string (${JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value)})`;
  return `a ${typeof value}`;
}

function describeRef(ref: ToolRef): string {
  if (typeof ref === 'string') return ref;
  return ref.source ? `${ref.source}:${ref.name}` : ref.name;
}

/**
 * Resolve a step's runtime tool list against run state.
 *
 * Never throws. When the step has no usable `toolsFrom`, `tools` is the
 * literal list unchanged (a non-array literal is treated as empty, as the
 * executors always have).
 */
export function resolveToolsFrom(
  config: Pick<NeuronStepConfig, 'tools' | 'toolsFrom'>,
  state: unknown,
): ToolsFromResolution {
  const literal: ToolRef[] = Array.isArray(config.tools) ? config.tools : [];
  const { path, error } = normaliseToolsFromPath(config.toolsFrom);
  if (error) {
    return { path: null, tools: literal, added: [], duplicates: 0, warnings: [`${error}; ignored`] };
  }
  if (path === null) {
    return { path: null, tools: literal, added: [], duplicates: 0, warnings: [] };
  }

  const value = readPath(state, path);
  if (value === undefined || value === null) {
    return {
      path,
      tools: literal,
      added: [],
      duplicates: 0,
      warnings: [`toolsFrom "${path}" is missing from run state (${value === null ? 'null' : 'undefined'}); no runtime tools added`],
    };
  }
  if (!Array.isArray(value)) {
    return {
      path,
      tools: literal,
      added: [],
      duplicates: 0,
      warnings: [`toolsFrom "${path}" is ${describeValue(value)}, not an array of tool refs; ignored`],
    };
  }

  const seen = new Set<string>();
  for (const ref of literal) {
    // A malformed literal ref is the resolver's problem, not ours; it just
    // cannot take part in de-duplication.
    if (isToolRefShape(ref)) seen.add(toolRefKey(ref));
  }

  const added: ToolRef[] = [];
  const warnings: string[] = [];
  let duplicates = 0;
  value.forEach((entry, index) => {
    if (!isToolRefShape(entry)) {
      warnings.push(
        `toolsFrom "${path}"[${index}] is not a tool ref (expected a non-empty string or ` +
          `{ name, source? }), got ${describeValue(entry)}; skipped`,
      );
      return;
    }
    const key = toolRefKey(entry);
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    added.push(entry);
  });

  return { path, tools: [...literal, ...added], added, duplicates, warnings };
}

/** One-line summary of what `toolsFrom` contributed, for the run log. */
export function summariseToolsFrom(res: ToolsFromResolution, maxNames = 20): string {
  const names = res.added.slice(0, maxNames).map(describeRef);
  const more = res.added.length > maxNames ? `, +${res.added.length - maxNames} more` : '';
  const dupes = res.duplicates > 0 ? ` (${res.duplicates} duplicate${res.duplicates === 1 ? '' : 's'} dropped)` : '';
  return `toolsFrom "${res.path}" added ${res.added.length} runtime tool${res.added.length === 1 ? '' : 's'}` +
    `${names.length ? `: ${names.join(', ')}${more}` : ''}${dupes}; step offers ${res.tools.length} in total`;
}
