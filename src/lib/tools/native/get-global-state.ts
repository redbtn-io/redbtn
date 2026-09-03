/**
 * Get Global State — Native Tool
 *
 * Reads a single value from a global-state namespace via the webapp API
 * (`GET /api/v1/state/namespaces/:namespace/values/:key`).
 *
 * Spec: TOOL-HANDOFF.md §4.2
 *   - inputs: namespace (required), key (required),
 *             path/offset/limit + size budgets (optional)
 *   - output: { value: any, exists: boolean, ... }
 *
 * Auth pattern (mirrors GlobalStateClient.getValue):
 *   - Authorization: Bearer ${authToken} when context.state.authToken present
 *   - Fallback: X-Internal-Key + X-User-Id headers
 *
 * ── Why this tool is bounded ──────────────────────────────────────────────
 * A single global-state VALUE is unbounded. Measured in production
 * 2026-09-02/03, namespace `Red-Projects`:
 *
 *     Become        138,014 B      redbtn         41,821 B
 *     eliteEntries  127,970 B      jfc             6,812 B
 *
 * Rendered into a Gemini Live `toolResponse`, 138 KB does not error — the tool
 * reports ok=true and the model simply cannot use the payload, so it
 * acknowledges the call, never answers, and calls another tool. The voice
 * session loops on "one moment..." forever. The webapp's 32 KB
 * `capToolResultForRealtime` cap (f84a82c1) stops the bleeding but cannot fetch
 * the rest.
 *
 * `list_global_state` was paginated first (#369). That was only half a fix: its
 * truncation marker points the model AT `get_global_state` for the full value,
 * so an unbounded `get_global_state` just moved the landmine one step
 * downstream. This is the other half.
 *
 * ── The budgets ───────────────────────────────────────────────────────────
 * Deliberately the SAME option names, defaults and marker shape as
 * `list_global_state`, so a model that learned one has learned the other:
 *
 *   1. `maxTotalBytes` (16384) — total budget for the emitted value.
 *   2. `maxValueBytes` (1024)  — per-MEMBER clip once the value is over budget;
 *                                an oversized member becomes a self-describing
 *                                `{ __truncated: true, bytes, type, fields,
 *                                preview, path, hint }` marker.
 *   3. `offset` / `limit`      — which members come back, for paging.
 *
 * "Member" means: an object's fields (sorted by name, so paging is stable), an
 * array's elements (index order), or a string's characters. That single
 * definition is what makes every shape of value retrievable in full.
 *
 * ── Two deliberate divergences from list_global_state ─────────────────────
 * 1. WHOLE-VALUE FAST PATH. If the value already fits `maxTotalBytes`, it is
 *    returned untouched — the per-member clip is NOT applied. In `list` a page
 *    mixes many keys, so per-key clipping is what keeps one fat key from
 *    crowding out the others; here there is exactly one value and the total
 *    budget is the whole story. Clipping a 3 KB config object's 1.2 KB nested
 *    field would be gratuitous damage to the non-voice callers that read these
 *    values in graphs. Consequence: for every value under 16 KB — the
 *    overwhelming majority — output is byte-identical to the old tool.
 * 2. ONE LEVEL OF REDUCTION. Members are clipped, but their children are not
 *    recursively summarised. Recursive summarisation makes the emitted size
 *    hard to predict and the result hard to reason about; `path` is the
 *    drill-down mechanism instead, and every marker carries the exact `path`
 *    string for its own next call.
 *
 * Backward compatibility: when the whole value comes back untouched and the
 * caller asked for nothing new, the payload is literally `{ "value": ...,
 * "exists": ... }` — no envelope at all, exactly as before. So every value under
 * `maxTotalBytes`, which is everything the non-voice graph callers read, is
 * byte-for-byte unaffected. The envelope appears only when the result is NOT
 * simply the whole value. `maxValueBytes: 0, maxTotalBytes: 0` (the same
 * incantation `list_global_state` uses) removes the budget entirely, so a value
 * of ANY size comes back bare — the explicit opt-out.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import type { Segment } from './_json-path';
import { parseJsonPath, resolveJsonPath, joinJsonPath } from './_json-path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

/**
 * Defaults. These match `list_global_state` exactly and for the same reasons —
 * the DEFAULT is the point, because an unparameterised call from a voice
 * session has to be safe.
 *
 * DEFAULT_MAX_VALUE_BYTES 1024  — enough for a status blurb / small config, and
 *                       it is what turns a 74 KB `todo` array into a one-line
 *                       marker while its 8-byte `name` sibling survives intact.
 * DEFAULT_MAX_TOTAL_BYTES 16384 — half the webapp realtime client's 32 KB
 *                       aggregate cap, so a full read can share a turn with
 *                       other tool results without tripping that guard.
 */
const DEFAULT_MAX_VALUE_BYTES = 1024;
const DEFAULT_MAX_TOTAL_BYTES = 16384;

/** Field names listed on a truncation marker, so the model sees the shape. */
const MARKER_FIELD_SAMPLE = 40;

interface GetGlobalStateArgs {
  namespace: string;
  key: string;
  path?: string;
  offset?: number;
  skip?: number;
  limit?: number;
  keysOnly?: boolean;
  maxValueBytes?: number;
  maxTotalBytes?: number;
}

/**
 * Resolve the webapp base URL the same way GlobalStateClient does.
 * Tests stub this via `WEBAPP_URL`.
 */
function getBaseUrl(): string {
  return process.env.WEBAPP_URL || 'http://localhost:3000';
}

/**
 * Build the auth-and-content headers used for state-API calls.
 *
 * Mirrors GlobalStateClient.getHeaders() — auth precedence is
 * Bearer first, then internal-key + user-id, then anonymous.
 */
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
 * How many members a value has, under the definition above. Scalars have one
 * member — themselves — so `total`/`returned` stay meaningful for every shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function memberCount(value: any): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 1;
}

/**
 * Replace an oversized member with a marker that says what was dropped and how
 * to get it. An explicit marker is the difference between a model that answers
 * "Become's todo list is large, want me to read it?" and one that silently
 * invents. Same shape as `list_global_state`'s marker, plus `path`: the exact
 * selector to pass back, so the next call is a copy-paste rather than a guess.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function truncationMarker(
  namespace: string,
  key: string,
  memberPath: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
  bytes: number,
  budget: number,
): AnyObject {
  const marker: AnyObject = {
    __truncated: true,
    bytes,
    type: valueType(value),
    path: memberPath,
    hint:
      `Value is ${bytes} bytes, over the ${budget}-byte maxValueBytes budget. ` +
      `Call get_global_state with namespace "${namespace}", key "${key}" and ` +
      `path "${memberPath}" to read this member on its own (it is paged the same way), ` +
      `or re-call with a larger maxValueBytes.`,
  };

  if (Array.isArray(value)) {
    marker.length = value.length;
  } else if (value && typeof value === 'object') {
    const fields = Object.keys(value);
    marker.fields = fields.slice(0, MARKER_FIELD_SAMPLE);
    if (fields.length > MARKER_FIELD_SAMPLE) marker.fieldsOmitted = fields.length - MARKER_FIELD_SAMPLE;
  }

  // A clipped preview of the serialised member. Deliberately a plain string —
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

interface ReduceOptions {
  namespace: string;
  key: string;
  basePath: string;
  offset: number;
  limit: number;
  maxValueBytes: number;
  maxTotalBytes: number;
}

interface ReduceResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitted: any;
  total: number;
  returned: number;
  truncatedMembers: string[];
  budgetStopped: boolean;
  bytes: number;
}

/**
 * Emit as much of `value` as the budgets allow, one level deep.
 *
 * The loop is the same greedy fill `list_global_state` runs over a namespace's
 * keys — clip the oversized, stop at the page budget, and ALWAYS emit at least
 * one member so a caller paging through can always make progress.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reduceValue(value: any, o: ReduceOptions): ReduceResult {
  const total = memberCount(value);

  // Strings have no structure to preserve, so they page as a character slice.
  // A slice is genuinely readable, where a marker would not be.
  if (typeof value === 'string') {
    const start = Math.min(o.offset, value.length);
    let take = value.length - start;
    if (o.maxTotalBytes > 0) take = Math.min(take, o.maxTotalBytes);
    if (o.limit > 0) take = Math.min(take, o.limit);
    const slice = value.slice(start, start + take);
    return {
      emitted: slice,
      total,
      returned: slice.length,
      truncatedMembers: [],
      budgetStopped: start + slice.length < value.length,
      bytes: jsonSize(slice),
    };
  }

  const isArray = Array.isArray(value);
  const isObject = !isArray && value !== null && typeof value === 'object';

  // Scalars (number / boolean / null) cannot exceed any sane budget.
  if (!isArray && !isObject) {
    return {
      emitted: value,
      total: 1,
      returned: 1,
      truncatedMembers: [],
      budgetStopped: false,
      bytes: jsonSize(value),
    };
  }

  // Sorted key order so a given offset always means the same slice, even if the
  // stored object's insertion order changes between calls.
  const memberKeys: string[] = isArray
    ? (value as unknown[]).map((_, i) => String(i))
    : Object.keys(value as AnyObject).sort();

  const window = memberKeys.slice(
    o.offset,
    o.limit > 0 ? o.offset + o.limit : undefined,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outObject: AnyObject = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outArray: any[] = [];
  const truncatedMembers: string[] = [];
  let usedBytes = 0;
  let budgetStopped = false;
  let returned = 0;

  for (const member of window) {
    const raw = isArray
      ? (value as unknown[])[Number(member)]
      : (value as AnyObject)[member];
    const rawBytes = jsonSize(raw);
    const memberPath = joinJsonPath(o.basePath, isArray ? Number(member) : member);

    let emitted = raw;
    if (o.maxValueBytes > 0 && rawBytes > o.maxValueBytes) {
      emitted = truncationMarker(o.namespace, o.key, memberPath, raw, rawBytes, o.maxValueBytes);
      truncatedMembers.push(member);
    }

    // `+ member.length + 4` approximates the `"key":` and `,` framing so the
    // budget tracks the real serialised size of the emitted container.
    const cost = jsonSize(emitted) + (isArray ? 1 : member.length + 4);

    // Always emit at least one member: a page that returns nothing can never
    // make progress, and the caller would page forever.
    if (o.maxTotalBytes > 0 && returned > 0 && usedBytes + cost > o.maxTotalBytes) {
      budgetStopped = true;
      // A marker for a member we are not emitting is not a real truncation —
      // drop it from the report.
      if (truncatedMembers[truncatedMembers.length - 1] === member) truncatedMembers.pop();
      break;
    }

    if (isArray) outArray.push(emitted);
    else outObject[member] = emitted;
    usedBytes += cost;
    returned += 1;
  }

  const out = isArray ? outArray : outObject;
  return {
    emitted: out,
    total,
    returned,
    truncatedMembers,
    budgetStopped,
    bytes: jsonSize(out),
  };
}

/**
 * The member inventory — names, sizes, types and the exact drill-in path, with
 * no values at all. The cheapest possible "what is in this thing?" call, and
 * the counterpart to `list_global_state`'s `keysOnly`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inventory(value: any, basePath: string, offset: number, limit: number): AnyObject[] {
  if (Array.isArray(value)) {
    const end = limit > 0 ? offset + limit : value.length;
    return value.slice(offset, end).map((item, i) => {
      const idx = offset + i;
      return {
        key: String(idx),
        path: joinJsonPath(basePath, idx),
        bytes: jsonSize(item),
        type: valueType(item),
      };
    });
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const end = limit > 0 ? offset + limit : keys.length;
    return keys.slice(offset, end).map((k) => ({
      key: k,
      path: joinJsonPath(basePath, k),
      bytes: jsonSize((value as AnyObject)[k]),
      type: valueType((value as AnyObject)[k]),
    }));
  }

  // Strings and scalars have no members to inventory — `type`, `total` and the
  // notice on the envelope carry everything there is to say.
  return [];
}

/**
 * Render the caller's path in canonical `$`-rooted form, so markers built on
 * top of it read like something the model can paste straight back
 * (`todo` and `.todo` both become `$.todo`).
 */
function normalisePathRoot(rawPath: string): string {
  const p = rawPath.trim();
  if (!p) return '$';
  if (p.startsWith('$')) return p;
  if (p.startsWith('[')) return `$${p}`;
  if (p.startsWith('.')) return `$${p}`;
  return `$.${p}`;
}

const getGlobalStateTool: NativeToolDefinition = {
  description:
    'Read a single value from a global-state namespace. Use to fetch persistent data shared across workflow runs (e.g. counters, config, last-seen markers). ' +
    'Bounded by default: a value over 16KB comes back one page at a time, with members over 1KB replaced by a marker giving the size, shape and a preview, ' +
    'because a single value can be hundreds of KB and will not fit in context. ' +
    'The response reports total, returned, hasMore and nextOffset — say "showing X of Y" and call again with offset for more. ' +
    'Use path to drill into one field (e.g. "$.todo"), and keysOnly:true to just see what fields exist.',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace name (e.g. "user-prefs").',
      },
      key: {
        type: 'string',
        description: 'The key within the namespace (e.g. "favourite_color").',
      },
      path: {
        type: 'string',
        description:
          'Optional JSONPath-style selector applied to the value before it is budgeted, for drilling into one part of a large value ' +
          '(e.g. "$.todo", "$.todo[0]", "$[\'full name\']"). Same syntax as json_query: $, .field, ["field"], [N], [-N]. ' +
          'Wildcards, filters and slices are not supported. Truncation markers tell you the exact path to pass.',
      },
      offset: {
        type: 'integer',
        description:
          'Number of members of the value to skip, for paging. Members are an object\'s fields (sorted by name, so paging is stable), ' +
          'an array\'s elements, or a string\'s characters. Use the nextOffset returned by the previous call. Default 0.',
        minimum: 0,
      },
      limit: {
        type: 'integer',
        description:
          'Optional cap on how many members to return. The byte budget is the primary bound — a count limit alone does not bound the size ' +
          'of a payload — so leave this unset unless you specifically want N fields or N array elements. Default: unlimited.',
        minimum: 1,
      },
      keysOnly: {
        type: 'boolean',
        description:
          'Return only the value\'s member names, sizes, types and drill-in paths — no content. The cheapest way to see what a large value holds. Default false.',
      },
      maxValueBytes: {
        type: 'integer',
        description:
          `Per-member size budget in serialised bytes, applied only once the value as a whole is over maxTotalBytes. A member larger than ` +
          `this is replaced by a { __truncated: true, bytes, type, fields, preview, path, hint } marker instead of being inlined. ` +
          `Default ${DEFAULT_MAX_VALUE_BYTES}. 0 = no per-member clipping (dangerous on large values).`,
        minimum: 0,
      },
      maxTotalBytes: {
        type: 'integer',
        description:
          `Total size budget for the returned value, in serialised bytes. A value that already fits is returned untouched; ` +
          `a larger one is returned a page of members at a time. At least one member is always returned. ` +
          `Default ${DEFAULT_MAX_TOTAL_BYTES}. 0 = no budget — with maxValueBytes 0 this restores the old unbounded output exactly.`,
        minimum: 0,
      },
    },
    required: ['namespace', 'key'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = (rawArgs ?? {}) as Partial<GetGlobalStateArgs>;
    const namespace = typeof args.namespace === 'string' ? args.namespace.trim() : '';
    const key = typeof args.key === 'string' ? args.key.trim() : '';

    if (!namespace) {
      return errorResult({
        error: 'namespace is required and must be a non-empty string',
        code: 'VALIDATION',
      });
    }

    if (!key) {
      return errorResult({
        error: 'key is required and must be a non-empty string',
        code: 'VALIDATION',
      });
    }

    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
    // `skip` is accepted as an alias so this tool reads the same as
    // list_global_state and query_state_records.
    const offset = Math.max(toInt(args.offset ?? args.skip, 0), 0);
    const limit = Math.max(toInt(args.limit, 0), 0);
    const keysOnly = toBool(args.keysOnly);
    const maxValueBytes = Math.max(toInt(args.maxValueBytes, DEFAULT_MAX_VALUE_BYTES), 0);
    const maxTotalBytes = Math.max(toInt(args.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES), 0);

    // Parse the path BEFORE the network call — an unsupported selector is a
    // caller error, not a reason to spend a round trip.
    let segments: Segment[] = [];
    if (rawPath) {
      try {
        segments = parseJsonPath(rawPath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult({
          error: `Invalid path: ${message}`,
          code: 'VALIDATION',
        });
      }
    }

    const baseUrl = getBaseUrl();
    const url =
      `${baseUrl}/api/v1/state/namespaces/${encodeURIComponent(namespace)}` +
      `/values/${encodeURIComponent(key)}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let stored: any;
    try {
      const response = await fetch(url, { headers: buildHeaders(context) });

      // 404 → key not found is a normal "exists: false" result, not an error.
      // Unchanged, and deliberately never carries the paging envelope: callers
      // branch on this shape.
      if (response.status === 404) {
        return okResult({ value: null, exists: false });
      }

      if (!response.ok) {
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
      }

      const data = (await response.json()) as AnyObject;
      stored = data?.value ?? null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult({ error: message });
    }

    let resolved = stored;
    let basePath = '$';
    if (rawPath) {
      const hit = resolveJsonPath(stored, segments);
      if (!hit.found) {
        return okResult({
          value: null,
          exists: true,
          namespace,
          key,
          path: rawPath,
          pathFound: false,
          notice:
            `The key exists but path "${rawPath}" does not resolve to anything in it. ` +
            `Call again with keysOnly: true (and no path) to see which members the value actually has.`,
        });
      }
      resolved = hit.value;
      basePath = normalisePathRoot(rawPath);
    }

    const type = valueType(resolved);
    const total = memberCount(resolved);
    const storedBytes = jsonSize(resolved);

    // BARE OUTPUT — the strongest form of backward compatibility. When the whole
    // value comes back untouched and the caller asked for nothing new, emit
    // literally `{ "value": ..., "exists": ... }`, exactly as this tool did
    // before it was bounded. Every value under maxTotalBytes — the overwhelming
    // majority, and everything the non-voice graph callers read — is therefore
    // byte-for-byte unaffected by this change. The envelope appears only when
    // the result is NOT simply the whole value, which is precisely when a model
    // has to be told so.
    //
    // This subsumes the explicit opt-out: `maxValueBytes: 0, maxTotalBytes: 0`
    // (the same incantation list_global_state uses; maxTotalBytes: 0 alone is
    // enough) removes the budget, so any value of any size comes back bare.
    const wantsEnvelope = Boolean(rawPath) || keysOnly || offset > 0 || limit > 0;
    if (!wantsEnvelope && (maxTotalBytes === 0 || storedBytes <= maxTotalBytes)) {
      return okResult({ value: resolved, exists: true });
    }

    if (keysOnly) {
      const keys = inventory(resolved, basePath, offset, limit);
      const consumed = offset + keys.length;
      const hasMore = consumed < total && keys.length > 0;
      return okResult({
        keys,
        exists: true,
        namespace,
        key,
        ...(rawPath ? { path: rawPath } : {}),
        type,
        bytes: storedBytes,
        total,
        returned: keys.length,
        offset,
        hasMore,
        nextOffset: hasMore ? consumed : null,
        notice: buildNotice({
          type,
          total,
          returned: keys.length,
          offset,
          hasMore,
          nextOffset: hasMore ? consumed : null,
          truncatedCount: 0,
          budgetStopped: false,
          maxTotalBytes,
          storedBytes,
          keysOnly: true,
          truncated: false,
        }),
      });
    }

    // WHOLE-VALUE FAST PATH — see the header. If it already fits, hand it back
    // untouched; do not clip members that were never a problem.
    const fitsWhole =
      (maxTotalBytes === 0 || storedBytes <= maxTotalBytes) && offset === 0 && limit === 0;

    if (fitsWhole) {
      return okResult({
        value: resolved,
        exists: true,
        namespace,
        key,
        ...(rawPath ? { path: rawPath } : {}),
        type,
        bytes: storedBytes,
        total,
        returned: total,
        offset: 0,
        hasMore: false,
        nextOffset: null,
        truncated: false,
      });
    }

    const reduced = reduceValue(resolved, {
      namespace,
      key,
      basePath,
      offset,
      limit,
      maxValueBytes,
      maxTotalBytes,
    });

    const consumed = offset + reduced.returned;
    const hasMore = consumed < reduced.total;
    const nextOffset = hasMore ? consumed : null;
    const truncated = reduced.truncatedMembers.length > 0 || hasMore || offset > 0;

    return okResult({
      value: reduced.emitted,
      exists: true,
      namespace,
      key,
      ...(rawPath ? { path: rawPath } : {}),
      type,
      bytes: reduced.bytes,
      storedBytes,
      total: reduced.total,
      returned: reduced.returned,
      offset,
      ...(limit > 0 ? { limit } : {}),
      hasMore,
      nextOffset,
      truncated,
      ...(reduced.truncatedMembers.length ? { truncatedMembers: reduced.truncatedMembers } : {}),
      notice: buildNotice({
        type,
        total: reduced.total,
        returned: reduced.returned,
        offset,
        hasMore,
        nextOffset,
        truncatedCount: reduced.truncatedMembers.length,
        budgetStopped: reduced.budgetStopped,
        maxTotalBytes,
        storedBytes,
        keysOnly: false,
        truncated,
      }),
    });
  },
};

/**
 * A one-line, model-readable summary of what this page is and is not. This is
 * the part that lets the assistant say "9 of 15 fields, want the rest?" instead
 * of presenting a partial value as if it were the whole thing.
 */
function buildNotice(o: {
  type: string;
  total: number;
  returned: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  truncatedCount: number;
  budgetStopped: boolean;
  maxTotalBytes: number;
  storedBytes: number;
  keysOnly: boolean;
  truncated: boolean;
}): string {
  const parts: string[] = [];
  const unit =
    o.type === 'array' ? 'element' : o.type === 'string' ? 'character' : 'field';

  if (o.keysOnly && o.type === 'string') {
    parts.push(
      `The value is a string of ${o.total} characters (${o.storedBytes} bytes) — it has no named members. ` +
        'Call again without keysOnly to read it; it pages by character offset.',
    );
    return parts.join(' ');
  }

  if (o.type !== 'array' && o.type !== 'object' && o.type !== 'string') {
    parts.push(`The whole value is a ${o.type} (${o.storedBytes} bytes).`);
  } else if (o.total === 0) {
    parts.push(`The value is an empty ${o.type}.`);
  } else if (o.returned === 0) {
    parts.push(`Offset ${o.offset} is past the end — the value has ${o.total} ${unit}(s).`);
  } else {
    const first = o.offset + 1;
    const last = o.offset + o.returned;
    parts.push(
      o.keysOnly
        ? `Listing member names only: ${unit}(s) ${first}-${last} of ${o.total}. The full value is ${o.storedBytes} bytes.`
        : `The stored value is ${o.storedBytes} bytes; showing ${unit}(s) ${first}-${last} of ${o.total}.`,
    );
  }

  if (o.budgetStopped && !o.keysOnly) {
    parts.push(
      `This page stopped early at the ${o.maxTotalBytes}-byte maxTotalBytes budget, not at the end of the value.`,
    );
  }

  if (o.hasMore && o.nextOffset !== null) {
    parts.push(`More remain — call again with offset: ${o.nextOffset}.`);
  } else if (o.total > 0 && o.returned > 0 && !o.keysOnly) {
    parts.push('No more members remain.');
  }

  if (o.truncatedCount > 0) {
    parts.push(
      `${o.truncatedCount} member(s) were too large to inline and appear as ` +
        `{ "__truncated": true, ... } markers listing their real size, shape, a preview and the ` +
        `path to read them — call get_global_state again with that path. Do not present a marker as the value.`,
    );
  }

  if (o.keysOnly) {
    parts.push('Content was not returned (keysOnly). Call again without keysOnly, or with a path, to read it.');
  } else if (o.truncated) {
    parts.push('This is a partial value — do not present it as the whole.');
  }

  return parts.join(' ');
}

export default getGlobalStateTool;
module.exports = getGlobalStateTool;
