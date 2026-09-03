/**
 * List Global State — Native Tool
 *
 * Returns key/value pairs from a global-state namespace via the webapp API
 * (`GET /api/v1/state/namespaces/:namespace/values`).
 *
 * Spec: TOOL-HANDOFF.md §4.2
 *   - inputs: namespace (required), limit/offset + size budgets (optional)
 *   - output: { values: { [key]: any }, total, returned, offset, limit, hasMore, ... }
 *
 * ── Why this tool is paginated ────────────────────────────────────────────
 * The upstream API hands back the WHOLE namespace in one object, and namespaces
 * grow without bound. Measured 2026-09-02 in production: `Red-Projects` is 20
 * keys / 328,317 characters, and the size is wildly skewed — two keys account
 * for 266 KB of it:
 *
 *     Become        138,014 B      redRun          6,522 B
 *     eliteEntries  127,970 B      mcpGateway      1,157 B
 *     redbtn         41,821 B      ...15 more keys under 900 B each
 *     jfc             6,812 B
 *
 * Rendered into a Gemini Live `toolResponse`, that payload does not error — it
 * simply exceeds what the model can use, so the model acknowledges the call,
 * never answers, and calls another tool. The voice session loops on
 * "one moment...". A 32 KB aggregate cap shipped in the webapp realtime client
 * (`capToolResultForRealtime`) stops the bleeding but cannot fetch page two.
 *
 * That skew is also why a key COUNT limit alone is not a fix: `limit: 1` on
 * `Red-Projects` can still return 138 KB. So this tool applies three budgets:
 *
 *   1. `limit` / `offset` — how many keys are on this page.
 *   2. `maxValueBytes`    — per-value clip; an oversized value is replaced by a
 *                           self-describing `{ __truncated: true, ... }` marker
 *                           carrying its real size, its field names and a
 *                           preview, so the model is TOLD what it is missing.
 *   3. `maxTotalBytes`    — a page byte budget; keys stop being added once the
 *                           page is full (at least one key is always emitted so
 *                           paging can always make progress).
 *
 * The response states the total key count and whether more remains, so a model
 * can say "19 of 340" and ask for the next page instead of guessing.
 *
 * Backward compatibility: `values` is still a plain key → value object and is
 * still the first thing in the payload. Existing non-voice callers that read
 * `body.values` keep working. To restore the old unbounded behaviour exactly,
 * pass `limit: 1000, maxValueBytes: 0, maxTotalBytes: 0` (0 = no budget).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

/**
 * Defaults. These are deliberately conservative because the DEFAULT is the
 * whole point — an unparameterised call from a voice session has to be safe.
 *
 * DEFAULT_LIMIT 25   — matches the sibling `query_state_records` convention.
 * DEFAULT_MAX_VALUE_BYTES 1024 — enough for a status blurb / small config, and
 *                      it is what turns a 138 KB key into a one-line marker.
 * DEFAULT_MAX_TOTAL_BYTES 16384 — half the webapp realtime client's 32 KB
 *                      aggregate cap, so one full page of this tool can share a
 *                      turn with other tool results without tripping that guard.
 */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 1000;
const DEFAULT_MAX_VALUE_BYTES = 1024;
const DEFAULT_MAX_TOTAL_BYTES = 16384;

/** Field names listed on a truncation marker, so the model sees the shape. */
const MARKER_FIELD_SAMPLE = 40;

interface ListGlobalStateArgs {
  namespace: string;
  limit?: number;
  offset?: number;
  skip?: number;
  keysOnly?: boolean;
  maxValueBytes?: number;
  maxTotalBytes?: number;
}

function getBaseUrl(): string {
  return process.env.WEBAPP_URL || 'http://localhost:3000';
}

function buildHeaders(context: NativeToolContext): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  const authToken =
    (context?.state?.authToken as string | undefined) ||
    (context?.state?.data?.authToken as string | undefined);
  const userId =
    (context?.state?.userId as string | undefined) ||
    (context?.state?.data?.userId as string | undefined);
  const internalKey = process.env.INTERNAL_SERVICE_KEY;

  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (userId) headers['X-User-Id'] = userId;
  if (internalKey) headers['X-Internal-Key'] = internalKey;

  return headers;
}

/**
 * Coerce a numeric arg. Models routinely send numbers as strings ("25"), so
 * accept both. Returns `fallback` for anything that is not a finite number.
 */
function toInt(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return fallback;
}

function toBool(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonSize(value: any): number {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s.length : 0;
  } catch {
    return 0;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function valueType(value: any): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Replace an oversized value with a marker that says what was dropped and how
 * to get it. An explicit marker is the difference between a model that answers
 * "Become is large, want me to read it?" and one that silently invents.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function truncationMarker(namespace: string, key: string, value: any, bytes: number, budget: number): AnyObject {
  const marker: AnyObject = {
    __truncated: true,
    bytes,
    type: valueType(value),
    hint:
      `Value is ${bytes} bytes, over the ${budget}-byte maxValueBytes budget. ` +
      `Call get_global_state with namespace "${namespace}" and key "${key}" to read it — ` +
      `that tool is bounded the same way, so a huge value comes back a page at a time ` +
      `(use its path/offset to go deeper) — or re-call list_global_state with a larger maxValueBytes.`,
  };

  if (Array.isArray(value)) {
    marker.length = value.length;
  } else if (value && typeof value === 'object') {
    const fields = Object.keys(value);
    marker.fields = fields.slice(0, MARKER_FIELD_SAMPLE);
    if (fields.length > MARKER_FIELD_SAMPLE) marker.fieldsOmitted = fields.length - MARKER_FIELD_SAMPLE;
  }

  // A clipped preview of the serialised value. Deliberately a plain string —
  // it is not valid JSON and must never be parsed as such.
  try {
    const serialised = JSON.stringify(value);
    if (typeof serialised === 'string' && budget > 0) {
      marker.preview = serialised.slice(0, budget);
    }
  } catch {
    /* unserialisable — the marker still carries type + size */
  }

  return marker;
}

function errorResult(payload: AnyObject): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}

function okResult(payload: AnyObject): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

const listGlobalStateTool: NativeToolDefinition = {
  description:
    'List key/value pairs in a global-state namespace, one page at a time. ' +
    'Paginated by default (25 keys, values over 1KB replaced with a marker giving the size and a preview, 16KB page budget) ' +
    'because a whole namespace can be hundreds of KB and will not fit in context. ' +
    'The response reports total, returned, hasMore and nextOffset — say "showing X of Y" and call again with offset for more. ' +
    'Use keysOnly:true to just see what keys exist, and get_global_state to read one large value (it is paged the same way).',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace name to enumerate.',
      },
      limit: {
        type: 'integer',
        description: `Max keys to return in this page. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
      offset: {
        type: 'integer',
        description:
          'Number of keys to skip, for paging. Keys are sorted by name so paging is stable. ' +
          'Use the nextOffset returned by the previous call. Default 0.',
        minimum: 0,
      },
      keysOnly: {
        type: 'boolean',
        description:
          'Return only key names, sizes and types — no values. The cheapest way to see what a namespace holds. Default false.',
      },
      maxValueBytes: {
        type: 'integer',
        description:
          `Per-value size budget in serialised bytes. A value larger than this is replaced by a ` +
          `{ __truncated: true, bytes, fields, preview, hint } marker instead of being inlined. ` +
          `Default ${DEFAULT_MAX_VALUE_BYTES}. 0 = no per-value clipping (dangerous on large namespaces).`,
        minimum: 0,
      },
      maxTotalBytes: {
        type: 'integer',
        description:
          `Total size budget for the returned values map, in serialised bytes. Keys stop being added ` +
          `once the page is full; at least one key is always returned. Default ${DEFAULT_MAX_TOTAL_BYTES}. 0 = no page budget.`,
        minimum: 0,
      },
    },
    required: ['namespace'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = (rawArgs ?? {}) as Partial<ListGlobalStateArgs>;
    const namespace = typeof args.namespace === 'string' ? args.namespace.trim() : '';

    if (!namespace) {
      return errorResult({
        error: 'namespace is required and must be a non-empty string',
        code: 'VALIDATION',
      });
    }

    const limit = Math.min(Math.max(toInt(args.limit, DEFAULT_LIMIT), 1), MAX_LIMIT);
    // `skip` is accepted as an alias so this tool reads the same as
    // query_state_records, which has used `skip` since the State Records pack.
    const offset = Math.max(toInt(args.offset ?? args.skip, 0), 0);
    const keysOnly = toBool(args.keysOnly);
    const maxValueBytes = Math.max(toInt(args.maxValueBytes, DEFAULT_MAX_VALUE_BYTES), 0);
    const maxTotalBytes = Math.max(toInt(args.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES), 0);

    const baseUrl = getBaseUrl();
    const url =
      `${baseUrl}/api/v1/state/namespaces/${encodeURIComponent(namespace)}/values`;

    let all: AnyObject;
    try {
      const response = await fetch(url, { headers: buildHeaders(context) });

      // Empty namespace or missing namespace → empty values map.
      if (response.status === 404) {
        all = {};
      } else if (!response.ok) {
        let body = '';
        try {
          body = await response.text();
        } catch {
          /* ignore */
        }
        return errorResult({
          error:
            `Global state API ${response.status} ${response.statusText}` +
            (body ? `: ${body.slice(0, 200)}` : ''),
          status: response.status,
        });
      } else {
        const data = (await response.json()) as AnyObject;
        all = data?.values && typeof data.values === 'object' ? data.values : {};
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult({ error: message });
    }

    // Sort by key name so a given offset always means the same slice, even if
    // the upstream object's insertion order changes between calls.
    const allKeys = Object.keys(all).sort();
    const total = allKeys.length;
    const pageKeys = allKeys.slice(offset, offset + limit);

    if (keysOnly) {
      const keys = pageKeys.map((key) => ({
        key,
        bytes: jsonSize(all[key]),
        type: valueType(all[key]),
      }));
      const consumed = offset + keys.length;
      const hasMore = consumed < total;
      return okResult({
        keys,
        namespace,
        total,
        returned: keys.length,
        offset,
        limit,
        hasMore,
        nextOffset: hasMore ? consumed : null,
        notice: buildNotice({
          total,
          returned: keys.length,
          offset,
          hasMore,
          nextOffset: hasMore ? consumed : null,
          truncatedCount: 0,
          budgetStopped: false,
          maxTotalBytes,
          keysOnly: true,
        }),
      });
    }

    const values: AnyObject = {};
    const truncatedValues: string[] = [];
    let usedBytes = 0;
    let budgetStopped = false;
    let returned = 0;

    for (const key of pageKeys) {
      const raw = all[key];
      const rawBytes = jsonSize(raw);

      let emitted = raw;
      if (maxValueBytes > 0 && rawBytes > maxValueBytes) {
        emitted = truncationMarker(namespace, key, raw, rawBytes, maxValueBytes);
        truncatedValues.push(key);
      }

      // `+ key.length + 4` approximates the `"key":` and `,` framing so the
      // budget tracks the real serialised size of the values map.
      const cost = jsonSize(emitted) + key.length + 4;

      // Always emit at least one key: a page that returns nothing can never
      // make progress, and the caller would page forever.
      if (maxTotalBytes > 0 && returned > 0 && usedBytes + cost > maxTotalBytes) {
        budgetStopped = true;
        // The truncation marker for a key we are not emitting is not a real
        // truncation — drop it from the report.
        if (truncatedValues[truncatedValues.length - 1] === key) truncatedValues.pop();
        break;
      }

      values[key] = emitted;
      usedBytes += cost;
      returned += 1;
    }

    const consumed = offset + returned;
    const hasMore = consumed < total;
    const nextOffset = hasMore ? consumed : null;

    return okResult({
      values,
      namespace,
      total,
      returned,
      offset,
      limit,
      hasMore,
      nextOffset,
      bytes: usedBytes,
      ...(truncatedValues.length ? { truncatedValues } : {}),
      notice: buildNotice({
        total,
        returned,
        offset,
        hasMore,
        nextOffset,
        truncatedCount: truncatedValues.length,
        budgetStopped,
        maxTotalBytes,
        keysOnly: false,
      }),
    });
  },
};

/**
 * A one-line, model-readable summary of what this page is and is not. This is
 * the part that lets the assistant say "19 of 340, want the rest?" instead of
 * presenting a partial namespace as if it were the whole thing.
 */
function buildNotice(o: {
  total: number;
  returned: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  truncatedCount: number;
  budgetStopped: boolean;
  maxTotalBytes: number;
  keysOnly: boolean;
}): string {
  const parts: string[] = [];

  if (o.total === 0) {
    parts.push('Namespace is empty (0 keys).');
  } else if (o.returned === 0) {
    parts.push(`Offset ${o.offset} is past the end — the namespace has ${o.total} key(s).`);
  } else {
    const first = o.offset + 1;
    const last = o.offset + o.returned;
    parts.push(
      o.keysOnly
        ? `Listing key names only: ${first}-${last} of ${o.total} key(s).`
        : `Showing key(s) ${first}-${last} of ${o.total}.`,
    );
  }

  if (o.budgetStopped) {
    parts.push(
      `This page stopped early at the ${o.maxTotalBytes}-byte maxTotalBytes budget, not at the key limit.`,
    );
  }

  if (o.hasMore && o.nextOffset !== null) {
    parts.push(`More remain — call again with offset: ${o.nextOffset}.`);
  } else if (o.total > 0 && o.returned > 0) {
    parts.push('No more keys remain.');
  }

  if (o.truncatedCount > 0) {
    parts.push(
      `${o.truncatedCount} value(s) were too large to inline and appear as ` +
        `{ "__truncated": true, ... } markers listing their real size and a preview — ` +
        `use get_global_state to read one — it pages the same way. Do not present a marker as the value.`,
    );
  }

  if (o.keysOnly) {
    parts.push('Values were not fetched (keysOnly). Call again without keysOnly to read them.');
  }

  return parts.join(' ');
}

export default listGlobalStateTool;
module.exports = listGlobalStateTool;
