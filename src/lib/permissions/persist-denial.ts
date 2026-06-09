/**
 * Denial persistence — fire-and-forget POST to the webapp.
 *
 * # What this is
 *
 * The data-permissions gate (`NativeToolRegistry.callTool`) already returns a
 * model-readable `isError` result and `console.warn`s on every
 * `CapabilityDeniedError`. That warning is ephemeral — it lives only in the
 * worker's stdout. This helper ADDS durable persistence: it fires a
 * best-effort POST to the webapp so denials can be surfaced in an operator
 * audit feed.
 *
 * # The trust boundary
 *
 * Native data tools do NOT write Mongo directly — they HTTP the webapp, which
 * authenticates the caller via the run's auth token and derives `userId` from
 * it. We follow the exact same pattern here (see `get-global-state.ts` /
 * `set-global-state.ts`): resolve the webapp base URL from `WEBAPP_URL`, and
 * send `Authorization: Bearer <authToken>`. We deliberately do NOT put `userId`
 * in the body — the webapp derives it from the token. Sending it would let a
 * compromised worker forge denials for arbitrary users.
 *
 * # Fire-and-forget guarantees
 *
 * This function NEVER throws and NEVER blocks. The denial result must return to
 * the model immediately, exactly as before. A persistence failure (no token, no
 * base URL, network error, non-2xx) is swallowed — it must never affect the run
 * or the denial result. The whole body is wrapped in try/catch, and the actual
 * `fetch` is voided with a `.catch(() => {})`.
 *
 * @module lib/permissions/persist-denial
 */

import type { NativeToolContext } from '../tools/native-registry';
import type { CapabilityDeniedError } from './types';

/**
 * Resolve the webapp base URL the same way the state tools do. Returns
 * undefined only if explicitly blanked — defaults to localhost otherwise, which
 * matches `get-global-state.ts`/`set-global-state.ts`. We still treat an empty
 * string as "unavailable" and skip.
 */
function resolveWebappBase(): string | undefined {
  const raw = process.env.WEBAPP_URL || 'http://localhost:3000';
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Build the webapp auth headers EXACTLY like the native state tools'
 * `buildHeaders` (see `native/set-global-state.ts`). Worker runs do NOT carry a
 * user Bearer token — they authenticate as a service principal via
 * `X-Internal-Key` + `X-User-Id`. Sending only `Authorization: Bearer` (the
 * original mistake) meant the POST was skipped on every real worker run.
 *
 * Returns the header map plus `canAuth` — true when the request can authenticate
 * at all (a Bearer token, OR an internal key paired with a user id). When false
 * we skip the POST (the console.warn in the gate remains the fallback record).
 */
function buildAuthHeaders(context: NativeToolContext): {
  headers: Record<string, string>;
  canAuth: boolean;
} {
  const state = context?.state as Record<string, any> | undefined;
  const authToken =
    (state?.authToken as string | undefined) || (state?.data?.authToken as string | undefined);
  const userId =
    (state?.userId as string | undefined) || (state?.data?.userId as string | undefined);
  const internalKey = process.env.INTERNAL_SERVICE_KEY;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (userId) headers['X-User-Id'] = userId;
  if (internalKey) headers['X-Internal-Key'] = internalKey;

  // The webapp accepts either a Bearer credential or a service principal
  // (X-Internal-Key + X-User-Id). Anything less can't authenticate → skip.
  const canAuth = !!authToken || (!!internalKey && !!userId);
  return { headers, canAuth };
}

/**
 * Pull a run-identity field from the tool context, following the same
 * resolution chain the universal-node tool executor uses:
 *   `state.<field>` → `state.data.<field>` → `state.data.options.<field>`.
 */
function resolveField(context: NativeToolContext, field: string): string | undefined {
  const state = context?.state as Record<string, any> | undefined;
  const v =
    state?.[field] ??
    state?.data?.[field] ??
    state?.data?.options?.[field];
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Persist a capability denial to the webapp, fire-and-forget.
 *
 * Called from the gate's `CapabilityDeniedError` branch AFTER the
 * `console.warn`. Returns immediately; the POST happens in the background and
 * any failure is swallowed.
 *
 * @param context  The native-tool execution context (carries run state + auth).
 * @param name     The tool name passed to `callTool`.
 * @param err      The thrown CapabilityDeniedError (carries resource/action/etc).
 */
export function persistDenial(
  context: NativeToolContext,
  name: string,
  err: CapabilityDeniedError,
): void {
  try {
    const base = resolveWebappBase();
    const { headers, canAuth } = buildAuthHeaders(context);

    // Graceful skip: without a base URL or a usable credential we cannot
    // durably persist. The console.warn in the gate is the fallback record.
    if (!base || !canAuth) return;

    // Contract body — MUST match the webapp receiver exactly. No userId: the
    // webapp derives it from the bearer token (trust boundary).
    const body = {
      runId: resolveField(context, 'runId') ?? null,
      graphId: resolveField(context, 'graphId') ?? null,
      conversationId: resolveField(context, 'conversationId') ?? null,
      agentId: resolveField(context, 'agentId') ?? null,
      profileName: err.profileName,
      resource: err.resource,
      action: err.action,
      address: err.address,
      toolName: name,
      reason: err.message,
    };

    // Fire-and-forget: never await, never let a rejection escape.
    void fetch(`${base}/api/v1/permissions/denials`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
      .then(() => {
        /* success path is intentionally empty — persistence is best-effort */
      })
      .catch(() => {
        /* swallow — a persistence failure must never affect the run */
      });
  } catch {
    /* swallow any synchronous error (URL build, JSON.stringify, etc.) */
  }
}

export default persistDenial;
