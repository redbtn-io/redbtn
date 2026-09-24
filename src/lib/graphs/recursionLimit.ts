/**
 * Configuration and error helpers for LangGraph execution recursion limits.
 *
 * @module lib/graphs/recursionLimit
 */

export const DEFAULT_RECURSION_LIMIT = 10_000;
export const MAX_RECURSION_LIMIT = 100_000;

/**
 * Resolves the recursion limit for a graph run.
 * Priority:
 *   1. graphConfig.config.recursionLimit ?? graphConfig.recursionLimit
 *   2. process.env.ENGINE_DEFAULT_RECURSION_LIMIT
 *   3. DEFAULT_RECURSION_LIMIT (10,000)
 *
 * Always clamped to [1, MAX_RECURSION_LIMIT (100,000)].
 */
export function resolveRecursionLimit(graphConfig?: Record<string, any> | null): number {
  let limit: number | undefined;

  const rawCandidate = graphConfig?.config?.recursionLimit ?? graphConfig?.recursionLimit;
  if (typeof rawCandidate === 'number' && Number.isFinite(rawCandidate) && rawCandidate > 0) {
    limit = Math.floor(rawCandidate);
  } else if (typeof rawCandidate === 'string' && rawCandidate.trim() !== '') {
    const parsed = parseInt(rawCandidate.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = parsed;
    }
  }

  if (limit === undefined) {
    const envRaw = process.env.ENGINE_DEFAULT_RECURSION_LIMIT;
    if (envRaw) {
      const parsedEnv = parseInt(envRaw.trim(), 10);
      if (Number.isFinite(parsedEnv) && parsedEnv > 0) {
        limit = parsedEnv;
      }
    }
  }

  if (limit === undefined) {
    limit = DEFAULT_RECURSION_LIMIT;
  }

  return Math.min(Math.max(1, limit), MAX_RECURSION_LIMIT);
}

/**
 * True if the error was caused by reaching the LangGraph recursion limit.
 */
export function isGraphRecursionError(error: unknown): boolean {
  if (!error) return false;
  if ((error as any)?.name === 'GraphRecursionError') return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /recursion limit of \d+ reached/i.test(msg);
}

/**
 * Returns a human-friendly error message when recursion limit is hit,
 * naming the limit and explaining how to raise it.
 */
export function formatRecursionLimitError(error: unknown, fallbackLimit?: number): string {
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/recursion limit of (\d+) reached/i);
  const limit = match ? match[1] : String(fallbackLimit ?? DEFAULT_RECURSION_LIMIT);
  return `Graph recursion limit of ${limit} reached without hitting a stop condition. You can raise it by setting graph.config.recursionLimit (up to ${MAX_RECURSION_LIMIT}) or the ENGINE_DEFAULT_RECURSION_LIMIT environment variable.`;
}
