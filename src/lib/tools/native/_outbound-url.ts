/**
 * Shared control for native tools that fetch a URL the CALLER supplied.
 *
 * # Why this file exists
 *
 * PR #378 closed the internal-auth + SSRF hole for `fetch_url`, `scrape_url`,
 * `web_search` and `ssh_copy(sourceUrl)`. Its round-3 review then found four
 * more tools of exactly the same class that were never guarded — `send_webhook`,
 * `download_file`, `upload_attachment(url)` and `invoke_function(url)` — plus a
 * fifth, `transcribe_audio(audioUrl)`. Each raw-`fetch`ed a model-chosen URL, so
 * `send_webhook({ url: 'http://10.100.0.10:9000/...' })` from a prompt-injected
 * neuron was a one-call read/write proxy into the fleet.
 *
 * Rather than five copies of the same three lines, every one of them now calls
 * through here. Two rules, and they are the same two `fetch_url` enforces:
 *
 * 1. **The SSRF guard runs on every caller-supplied URL**, trusted or not —
 *    {@link safeFetch} in `lib/net/ssrf-guard` resolves the host, refuses any
 *    private / loopback / link-local answer, and re-checks each redirect hop
 *    (max 5). Trust decides who gets credentials; it does not decide who may
 *    reach the private network. The one relaxation is the explicit, empty-by-
 *    default `SSRF_ALLOW_HOSTS` env allowlist, which is honoured for TRUSTED
 *    requests only — see the `ssrf-guard` module header.
 * 2. **An untrusted caller never sends credential headers to an internal
 *    host.** None of these tools attaches the platform's `Authorization` /
 *    `X-User-Id` / `X-Internal-Key` the way `fetch_url` does, and none of them
 *    ever should. What they DO accept is a caller-supplied `headers` map, and a
 *    model that writes `{ Authorization: ... }` on a request to
 *    `app.redbtn.io` is aiming a credential it chose at the platform's own API.
 *    {@link sanitizeOutboundHeaders} drops those headers — but only for an
 *    untrusted caller AND only for an allowlisted internal host, so an authored
 *    step calling a third-party API with its own bearer token is untouched.
 *
 * # What this file does NOT do
 *
 * It does not add credential attachment anywhere. `fetch_url` remains the only
 * tool that attaches the run's identity to an internal host, and it keeps its
 * own inline implementation because it also runs a bespoke redirect loop.
 */

import type { NativeToolContext, NativeMcpResult } from '../native-registry';
import { isInternalHost } from './_internal-hosts';
import { SENSITIVE_HEADERS, SsrfBlockedError } from '../../net/ssrf-guard';

/**
 * True when the caller's arguments were chosen by a graph author rather than a
 * model.
 *
 * Fails closed in both directions that matter: an absent context, or an absent
 * flag, is read as "the author chose these arguments" (which is what
 * `NativeToolContext.untrustedCaller` documents), while anything a model
 * touched has the flag set explicitly by the tool-use loop, the stream parsers,
 * or `resolveToolStepTrust` for a graph `tool` step.
 *
 * The only thing this gates is the `SSRF_ALLOW_HOSTS` escape hatch and the
 * header sanitisation below — never the guard itself.
 */
export function callerIsTrusted(context: NativeToolContext | undefined | null): boolean {
  return context?.untrustedCaller !== true;
}

/**
 * Drop caller-supplied credential headers on a request an untrusted caller
 * aimed at an allowlisted internal redbtn host.
 *
 * Returns the headers unchanged for a trusted caller, and for any host that is
 * not internal — a webhook to Slack or a download from S3 legitimately carries
 * whatever `Authorization` the caller configured.
 *
 * @param toolName only used for the log line, so a drop is attributable.
 */
export function sanitizeOutboundHeaders(
  url: string,
  headers: Record<string, string>,
  context: NativeToolContext | undefined | null,
  toolName: string,
): Record<string, string> {
  if (callerIsTrusted(context)) return headers;
  if (!isInternalHost(url)) return headers;

  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADERS.indexOf(key.toLowerCase()) >= 0) {
      dropped.push(key);
      continue;
    }
    out[key] = headers[key];
  }

  if (dropped.length) {
    console.warn(
      `[${toolName}]`,
      `Dropped model-supplied credential header(s) ${dropped.join(', ')} on a request to the internal host ${
        (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return url;
          }
        })()
      }`,
    );
  }
  return out;
}

/**
 * Render an {@link SsrfBlockedError} as a tool result.
 *
 * A refused URL is a policy decision, not a transport failure: it carries its
 * own `code` so the model can tell "you may not go there" from "the site was
 * down", and so the run archive shows the block rather than a generic error.
 * Mirrors the shape `fetch_url` returns.
 */
export function ssrfBlockedResult(
  error: SsrfBlockedError,
  toolName: string,
  extra: Record<string, unknown> = {},
): NativeMcpResult {
  console.warn(`[${toolName}]`, `BLOCKED ${error.code}: ${error.message}`);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: error.message, code: error.code, ...extra }),
      },
    ],
    isError: true,
  };
}

/** Narrow an unknown thrown value to {@link SsrfBlockedError}. */
export function isSsrfBlockedError(err: unknown): err is SsrfBlockedError {
  return err instanceof SsrfBlockedError;
}

/**
 * The sentence every guarded tool appends to its model-facing `description`
 * and to its URL parameter's schema text.
 *
 * Worded as a *request-time* property on purpose. The guard resolves the host
 * and then `fetch` resolves it again, so a name that answers public once and
 * private on the connect (DNS rebinding) is a documented residual — see the
 * `ssrf-guard` module header. The model reads these strings as a guarantee, so
 * they must promise only what the code delivers. Do not reword this to "only
 * public hosts are reachable".
 */
export const PUBLIC_HOSTS_ONLY_NOTE =
  'Intended for public internet hosts: the request is refused when the URL\'s host resolves to a private, loopback or link-local address at request time, and every redirect hop is re-checked.';
