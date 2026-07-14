/**
 * Shared HTTP plumbing for the State Records native tools.
 *
 * The five record tools (`create_state_record`, `get_state_record`,
 * `query_state_records`, `update_state_record`, `delete_state_record`) are thin
 * proxies over the webapp's records API — auth, namespace access, PAT scopes,
 * limits and query compilation all happen server-side. What is left is
 * identical in every one of them: resolve the base URL, build the auth headers,
 * make the call, and normalize the failure.
 *
 * That is factored out here rather than copy-pasted five times, because the one
 * thing that must NOT drift between these tools is the auth header block.
 *
 * URL SURFACE — deliberately different from the older state tools:
 * the existing `get_global_state` / `set_global_state` / … tools call
 * `/api/v1/state/...`. Those `/api/v1/*` paths are the DEPRECATED alias layer
 * (see webapp `lib/aliasRoute.ts` — every hit logs a deprecation warning and
 * returns `Deprecation: true`). The records routes are canonical-only, so these
 * tools call `/api/state/...` directly rather than being born deprecated.
 */

import type { NativeToolContext, NativeMcpResult } from './native-registry';
import { formatStateApiError } from './state-error';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

/** Same resolution the other state tools use. Tests stub this via WEBAPP_URL. */
export function getBaseUrl(): string {
  return process.env.WEBAPP_URL || 'http://localhost:3000';
}

/**
 * Auth headers — mirrors `GlobalStateClient.getHeaders()` and every existing
 * state tool: Bearer first, then internal-key + user-id, then anonymous.
 */
export function buildHeaders(context: NativeToolContext): Record<string, string> {
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

/** Build a `.../records` collection URL for a namespace. */
export function recordsUrl(namespace: string, suffix = ''): string {
  return (
    `${getBaseUrl()}/api/state/namespaces/${encodeURIComponent(namespace)}/records${suffix}`
  );
}

/** Build a `.../records/<recordId>` URL. */
export function recordUrl(namespace: string, recordId: string): string {
  return recordsUrl(namespace, `/${encodeURIComponent(recordId)}`);
}

/** A validation failure the tool caught before making a request. */
export function toolError(error: string, code = 'VALIDATION'): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error, code }) }],
    isError: true,
  };
}

/** A successful result. */
export function toolOk(payload: unknown): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

/** Trim a required string arg, or return '' if it isn't one. */
export function requiredString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface RecordsRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  context: NativeToolContext;
  body?: unknown;
  /**
   * Treat a 404 as a normal result rather than an error, mapping it to this
   * payload. `get_state_record` uses it so "no such record" reads as
   * `{ found: false }` instead of a tool failure the agent has to interpret.
   */
  notFoundValue?: unknown;
}

/**
 * Make a records-API call and map the response into a tool result.
 *
 * Upstream errors are normalized through `formatStateApiError`, the same helper
 * `set_global_state` / `state_patch` use — so a 400 from the filter compiler or
 * a 409 record-limit reaches the agent as a readable message it can act on,
 * rather than a bare status code.
 */
export async function recordsFetch(
  req: RecordsRequest,
): Promise<{ ok: true; data: AnyObject } | { ok: false; result: NativeMcpResult }> {
  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: buildHeaders(req.context),
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    });

    if (response.status === 404 && req.notFoundValue !== undefined) {
      return { ok: false, result: toolOk(req.notFoundValue) };
    }

    const data = (await response.json().catch(() => ({}))) as AnyObject;

    if (!response.ok) {
      return {
        ok: false,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                formatStateApiError(data, response.status, response.statusText, 'State records API'),
              ),
            },
          ],
          isError: true,
        },
      };
    }

    return { ok: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      },
    };
  }
}
