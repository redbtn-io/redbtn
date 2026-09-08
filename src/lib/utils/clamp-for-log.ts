// How much one log record is allowed to weigh.
//
// WHY THIS EXISTS. A run's `Run started` record carried the run input verbatim.
// On 2026-09-08 a redBoard card with three screenshots arrived with those
// images inlined as base64 (3.3MB, and the trigger descriptor carried a second
// copy), so that ONE record was 6,670,203 bytes. Serialising it, redacting it
// and handing it to redlog — while the same object also sat in run state and
// was cloned per step — walked the worker into its V8 heap ceiling. Node died
// mid-run, the container restarted, and the SSH session executing the agent
// died with it.
//
// The source of that particular payload is fixed at its origin, but a log line
// must not be able to do this again whatever a trigger sends. A log record
// exists to say what happened; a megabyte of base64 says nothing that its size
// does not say better.
//
// Deliberately lossy and deliberately loud: what is dropped is replaced by a
// marker naming the original size, so a reader can tell the difference between
// "this field was empty" and "this field was too big to keep".

/** Keep this much of an over-long string, so the record still identifies it. */
const KEEP_CHARS = 256;
/** Strings longer than this are clipped. Generous: prompts and briefs are
 *  legitimately long, and reading one back is often the point of the log. */
const MAX_STRING_CHARS = 4096;
/** Arrays longer than this keep a head and a count. */
const MAX_ARRAY_ITEMS = 50;
/** Whole-record budget, applied after per-value clipping catches the common
 *  case of one enormous field. */
const MAX_TOTAL_CHARS = 64 * 1024;

function clipString(value: string): string {
  if (value.length <= MAX_STRING_CHARS) return value;
  return `${value.slice(0, KEEP_CHARS)}… [clipped, ${value.length} chars total]`;
}

function clipDeep(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return clipString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY_ITEMS).map((entry) => clipDeep(entry, seen));
    return value.length > MAX_ARRAY_ITEMS
      ? [...head, `… [clipped, ${value.length} items total]`]
      : head;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, clipDeep(child, seen)]),
  );
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Unserialisable metadata cannot be measured, and redlog could not have
    // stored it either. Treat it as over budget so the summary path runs.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * A copy of `metadata` small enough to store, with anything dropped replaced
 * by a marker naming what was there.
 *
 * Two passes. The first clips oversized strings and long arrays, which is what
 * a single huge field needs. If the record is STILL over budget — thousands of
 * merely-large fields, a deeply nested state snapshot — every non-scalar
 * top-level value is replaced by a size marker, keeping the scalars that
 * usually carry the identifying detail (runId, graphId, toolName).
 */
export function clampForLog<T>(metadata: T, maxTotalChars: number = MAX_TOTAL_CHARS): T {
  const clipped = clipDeep(metadata, new WeakSet<object>());
  if (sizeOf(clipped) <= maxTotalChars) return clipped as T;

  if (clipped === null || typeof clipped !== 'object' || Array.isArray(clipped)) {
    return `[clamped, ${sizeOf(clipped)} chars]` as unknown as T;
  }

  const summary = Object.fromEntries(
    Object.entries(clipped as Record<string, unknown>).map(([key, child]) => {
      if (child === null || typeof child !== 'object') return [key, child];
      return [key, `[clamped, ${sizeOf(child)} chars]`];
    }),
  );

  // Even the scalars can be too much (a record that is nothing but ten
  // thousand short keys). Say so rather than storing it.
  return (sizeOf(summary) <= maxTotalChars
    ? summary
    : { __clamped: true, chars: sizeOf(clipped), keys: Object.keys(clipped as object).length }) as unknown as T;
}

export { MAX_STRING_CHARS, MAX_ARRAY_ITEMS, MAX_TOTAL_CHARS };
