/**
 * Run-length limits for neuron steps (engine 0.0.301).
 *
 * One place that turns a step's `maxToolIterations`, `timeoutMs` and
 * `maxRepeatedToolCalls` into numbers, so every executor and the CLI run
 * bridge read them the same way.
 *
 * UNLIMITED: `0`, `-1`, `"unlimited"`, `"none"` or `Infinity` means "no limit".
 *   - `maxToolIterations: 0` -> no tool-call budget in the API tool loop, no
 *     call budget in the CLI run bridge, and no `--max-turns` for claude-code.
 *   - `timeoutMs: 0` -> no per-step wall clock (the run-level timeout,
 *     `graph.config.timeout` / ENGINE_DEFAULT_RUN_TIMEOUT_S, still applies).
 *   - `maxRepeatedToolCalls: 0` -> the runaway guard is off.
 * Unset (or anything unparseable) means the default below.
 *
 * Defaults were raised on 2026-10-13 after a Become Ops CLI run stopped at
 * 208 tool calls (old CLI default 50 turns -> 208 bridge calls). A cheap
 * runaway guard replaces the count caps as the protection against loops: the
 * same tool called with identical arguments, returning an identical result,
 * many times in a row.
 *
 * @module lib/neurons/run-limits
 */

/** CLI neurons (claude-code `--max-turns`, and the run bridge's turn basis). */
export const DEFAULT_CLI_MAX_TURNS = 500;

/** API neurons: tool-use loop iterations per step (was 5). */
export const DEFAULT_API_MAX_TOOL_ITERATIONS = 25;

/** Bridge calls allowed per CLI turn (a turn can issue several tool calls). */
export const BRIDGE_CALLS_PER_TURN = 4;

/**
 * Ceiling on an explicit numeric bridge budget (`maxToolIterations * 4 + 8`).
 * Was 2,000; a step that needs more opts into unlimited (`maxToolIterations: 0`).
 */
export const MAX_CALLS_CEILING = 20_000;

/** CLI step wall clock when the step sets none (was 2 h claude-code, 30 min agy/opencode/copilot). */
export const DEFAULT_CLI_STEP_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/**
 * "No per-step wall clock". setTimeout's maximum (about 24.8 days): larger
 * values overflow to 1 ms in Node, so unlimited is expressed as this, and the
 * run-level timeout is what actually bounds the run.
 */
export const UNLIMITED_TIMEOUT_MS = 2_147_483_647;

/** Runaway guard: identical call + identical result this many times in a row stops the loop. */
export const DEFAULT_MAX_REPEATED_TOOL_CALLS = 50;

const UNLIMITED_WORDS = new Set(['unlimited', 'none', 'infinity', 'inf', 'off', 'no-limit', 'nolimit']);

/**
 * Parse a limit. Returns `null` for UNLIMITED, a positive integer for a
 * limit, or `undefined` when the value is absent/unusable (caller's default).
 */
export function parseLimit(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number') {
    if (raw === Infinity || raw === 0 || raw === -1) return null;
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
    return undefined;
  }
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (UNLIMITED_WORDS.has(s)) return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseLimit(Number(s));
  }
  return undefined;
}

/** Tool-iteration (turn) limit: a positive integer, or `null` for unlimited. */
export function resolveToolIterationLimit(raw: unknown, defaultValue: number): number | null {
  const parsed = parseLimit(raw);
  return parsed === undefined ? defaultValue : parsed;
}

/**
 * The CLI run bridge's call budget for a step: `Infinity` when the step opted
 * into unlimited, else `turns * BRIDGE_CALLS_PER_TURN + 8` capped at
 * MAX_CALLS_CEILING.
 */
export function bridgeCallBudget(rawMaxToolIterations: unknown): number {
  const turns = resolveToolIterationLimit(rawMaxToolIterations, DEFAULT_CLI_MAX_TURNS);
  if (turns === null) return Infinity;
  return Math.min(turns * BRIDGE_CALLS_PER_TURN + 8, MAX_CALLS_CEILING);
}

/** A step's wall clock in ms; UNLIMITED_TIMEOUT_MS when the step opted out. */
export function resolveStepTimeoutMs(raw: unknown, defaultMs: number): number {
  const parsed = parseLimit(raw);
  if (parsed === undefined) return defaultMs;
  if (parsed === null) return UNLIMITED_TIMEOUT_MS;
  return Math.min(parsed, UNLIMITED_TIMEOUT_MS);
}

/** Runaway-guard threshold; `null` when the guard is off. */
export function resolveMaxRepeatedToolCalls(raw: unknown): number | null {
  return resolveToolIterationLimit(raw, DEFAULT_MAX_REPEATED_TOOL_CALLS);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * The runaway guard. Counts consecutive tool calls that are IDENTICAL (same
 * tool, same arguments) AND returned an IDENTICAL result. A poll whose result
 * changes (a status, a timestamp) never trips it; a model stuck re-issuing
 * the same call and getting the same answer does, after `limit` repeats.
 *
 *   const guard = new RepeatedCallGuard(limit);
 *   if (guard.shouldRefuse(name, args)) -> refuse this call
 *   ... execute ...; guard.record(name, args, result)
 */
export class RepeatedCallGuard {
  private lastCall: string | null = null;
  private lastResult: string | null = null;
  private streak = 0;

  constructor(private readonly limit: number | null) {}

  private callKey(name: string, args: unknown): string {
    try {
      return `${name}\u0000${stableStringify(args ?? {})}`;
    } catch {
      return `${name}\u0000<unserializable>`;
    }
  }

  /** True when this call would be the (limit+1)-th identical call with an identical result. */
  shouldRefuse(name: string, args: unknown): boolean {
    if (this.limit === null) return false;
    return this.lastCall === this.callKey(name, args) && this.streak >= this.limit;
  }

  /** Record a call that was executed and its result. */
  record(name: string, args: unknown, result: unknown): void {
    if (this.limit === null) return;
    const call = this.callKey(name, args);
    let res: string;
    try {
      res = stableStringify(result);
    } catch {
      res = String(Math.random());
    }
    if (call === this.lastCall && res === this.lastResult) {
      this.streak += 1;
    } else {
      this.lastCall = call;
      this.lastResult = res;
      this.streak = 1;
    }
  }

  /** Human message for a refused call. */
  message(name: string): string {
    return (
      `Error: '${name}' was called with identical arguments and returned an identical result ` +
      `${this.streak} times in a row, so this repeat was not executed (runaway guard, ` +
      `maxRepeatedToolCalls=${this.limit}). Change the arguments, use the result you already have, ` +
      'or finish.'
    );
  }
}
