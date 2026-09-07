/**
 * Fetch URL — Native Tool
 *
 * Makes an HTTP request to a URL and returns the response status, headers,
 * and body. Features:
 *   - Modern browser emulation headers by default
 *   - Auto-formatting for JSON and HTML (converts HTML to clean Markdown)
 *   - Configurable format ('auto', 'markdown', 'json', 'text', 'raw')
 *   - Internal-platform auth forwarding for allowlisted redbtn hosts,
 *     suppressed entirely for model-controlled (untrusted) callers
 *   - SSRF guard on the requested URL and on every redirect hop (best-effort:
 *     see the DNS-rebinding residual in `lib/net/ssrf-guard`)
 *   - Robust retry and abort signal support
 *
 * # Security
 *
 * Two independent controls, both mandatory:
 *
 * 1. **Internal-auth attachment** (`Authorization` / `X-User-Id` /
 *    `X-Internal-Key`) happens only for an allowlisted internal host AND only
 *    when `context.untrustedCaller` is falsy. The neuron tool-use loop sets
 *    that flag, so a model that picks the URL can never borrow the run's
 *    identity or the platform service key against an internal API. A graph
 *    `tool` step still authenticates, but only while its URL is a literal the
 *    author typed and the run was not entered through a model-invoked
 *    graph-as-tool — `resolveToolStepTrust` in `lib/tools/caller-trust` decides
 *    that per step, because `renderParameters` would otherwise let
 *    `{ url: '{{data.answer}}' }` reach this tool as a trusted caller.
 *
 *    On an internal host those three headers are set from the RUN CONTEXT and
 *    a caller-supplied copy is DROPPED, whatever the caller's trust. That is
 *    not tidiness: `{ url:'<literal internal url>', headers:{ 'X-User-Id':
 *    '{{state.data.answer}}' } }` is a trusted step by the destination test —
 *    the URL is the author's literal — and the previous "caller's header wins"
 *    merge let the model choose the PRINCIPAL while `X-Internal-Key` still went
 *    out. On the webapp side `X-Internal-Key` + `X-User-Id` is ADMIN
 *    impersonating that user id. The destination was the author's; the identity
 *    must be the run's.
 * 2. **SSRF guard** (`lib/net/ssrf-guard`) runs on every URL regardless of who
 *    the caller is: the requested URL and each redirect hop must resolve to a
 *    public address *at check time*. The worker sits on the private fleet
 *    network, so an unguarded fetch is a proxy into it. The check is not
 *    atomic with the connection — a name that answers public once and private
 *    on the connect (DNS rebinding) still gets through; closing that needs the
 *    checked address pinned into the dispatcher, and the tool's own
 *    descriptions are worded to promise only what the guard actually delivers.
 *    Do not restore absolute wording ("only public hosts are reachable") to
 *    the schema: the model reads those strings as a guarantee.
 *
 * Redirects are followed manually (max 5 hops) so hop 2..n gets the same
 * check as hop 1. Internal credentials are attached to the FIRST request only
 * and are never carried across a redirect.
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { isInternalHost } from './_internal-hosts';
import { buildHeaders } from './_task-helpers';
import {
  assertPublicUrl,
  assertPublicRedirect,
  isRedirectStatus,
  stripSensitiveHeaders,
  SsrfBlockedError,
  MAX_REDIRECT_HOPS,
} from '../../net/ssrf-guard';
import { parseHtml, DEFAULT_BROWSER_HEADERS } from '../../nodes/scrape/parser';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface FetchUrlArgs {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  followRedirects?: boolean;
  format?: 'auto' | 'markdown' | 'json' | 'text' | 'raw';
}

const fetchUrlTool: NativeToolDefinition = {
  description:
    'Fetch content from a URL or make an HTTP API call. Returns status code, headers, title, and body (automatically converted to clean Markdown for HTML pages or pretty JSON for APIs). Intended for public internet hosts: a URL is refused when its host resolves to a private, loopback or link-local address at request time, and every redirect hop is re-checked.',
  server: 'web',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch (must start with http:// or https://). Refused when the host resolves to a private, loopback or link-local address at the time of the request.',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        description: 'HTTP method to use (default GET).',
        default: 'GET',
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP request headers as key-value pairs.',
        additionalProperties: { type: 'string' },
      },
      body: {
        type: 'string',
        description: 'Optional request body (for POST, PUT, PATCH).',
      },
      timeout: {
        type: 'integer',
        description: 'Request timeout in milliseconds (default 30000, max 120000).',
        minimum: 1,
        maximum: 120000,
        default: 30000,
      },
      followRedirects: {
        type: 'boolean',
        description: 'Whether to automatically follow HTTP redirects (default true, max 5 hops).',
        default: true,
      },
      format: {
        type: 'string',
        enum: ['auto', 'markdown', 'json', 'text', 'raw'],
        description: 'Output body format: auto (default: Markdown for HTML, JSON for APIs), markdown, json, text, raw.',
        default: 'auto',
      },
    },
    required: ['url'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<FetchUrlArgs>;
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    let method = (typeof args.method === 'string' ? args.method.toUpperCase() : 'GET') as string;
    const headers = (args.headers && typeof args.headers === 'object' ? args.headers : {}) as Record<string, string>;
    let body: string | null = typeof args.body === 'string' ? args.body : null;
    let timeout = Number(args.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      timeout = 30_000;
    }
    timeout = Math.min(Math.floor(timeout), 120_000);
    const followRedirects = args.followRedirects !== false;
    const format = args.format || 'auto';

    if (!url) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'url is required and must be a non-empty string' }) }],
        isError: true,
      };
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'url must start with http:// or https://' }) }],
        isError: true,
      };
    }

    const runAbortSignal = context?.abortSignal || null;
    let timeoutFired = false;

    // SECURITY: a model-chosen URL never gets the platform's credentials.
    // See NativeToolContext.untrustedCaller.
    const callerIsUntrusted = context?.untrustedCaller === true;

    try {
      let currentUrl = url;
      let response: Response | null = null;
      let attachedInternalAuth = false;

      // Guard the URL the caller asked for before a single byte goes out.
      // `trusted` gates ONLY the `SSRF_ALLOW_HOSTS` escape hatch — a
      // model-chosen URL can never reach an allowlisted private address.
      await assertPublicUrl(currentUrl, { trusted: !callerIsUntrusted });
      const originalOrigin = new URL(currentUrl).origin;

      // ── redirect loop: one guarded hop per iteration ──────────────────────
      for (let hop = 0; ; hop++) {
        // Caller-supplied credential headers travel only as far as the origin
        // they were addressed to; a redirect off that origin drops them.
        const crossOrigin = hop > 0 && new URL(currentUrl).origin !== originalOrigin;
        const merged: Record<string, string> = { ...DEFAULT_BROWSER_HEADERS, ...headers };
        const fetchHeaders: Record<string, string> = crossOrigin ? stripSensitiveHeaders(merged) : merged;

        if (body && !fetchHeaders['Content-Type'] && !fetchHeaders['content-type']) {
          fetchHeaders['Content-Type'] = 'application/json';
        }

        // On an internal host the platform's identity headers are the run's,
        // full stop: any caller-supplied copy is removed FIRST, then the
        // run-context value is written. A caller cannot suppress one of them
        // either — leaving `X-Internal-Key` in place while the model picks
        // `X-User-Id` is precisely the escalation this closes.
        //
        // This runs for an untrusted caller too, where it only ever deletes:
        // the attach block below is skipped, so a model-chosen
        // `Authorization` never reaches an internal redbtn API at all.
        if (hop === 0 && isInternalHost(currentUrl)) {
          const dropped: string[] = [];
          for (const key of Object.keys(fetchHeaders)) {
            const lower = key.toLowerCase();
            if (lower === 'authorization' || lower === 'x-user-id' || lower === 'x-internal-key') {
              delete fetchHeaders[key];
              dropped.push(key);
            }
          }
          if (dropped.length) {
            console.warn('[fetch_url]', `Dropped caller-supplied ${dropped.join(', ')} on an internal-host request — these are set from the run context`);
          }
        }

        // Internal auth is attached to the ORIGINAL request only, never to a
        // redirect hop, and never at all for an untrusted caller.
        if (hop === 0 && !callerIsUntrusted && isInternalHost(currentUrl)) {
          const authHeaders = buildHeaders(context);
          for (const key of ['Authorization', 'X-User-Id', 'X-Internal-Key'] as const) {
            const value = authHeaders[key];
            if (value) {
              fetchHeaders[key] = value;
              attachedInternalAuth = true;
            }
          }
        }

        // Always 'manual': following inside fetch would re-resolve and connect
        // without ever consulting the SSRF guard again.
        const effectiveRedirect = 'manual' as const;

        const MAX_RETRIES = 2;
        const BACKOFF = [2_000, 5_000];
        response = null;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          if (runAbortSignal?.aborted) {
            const err: Error & { name: string } = new Error('fetch_url aborted before send');
            err.name = 'AbortError';
            throw err;
          }

          const controller = new AbortController();
          const timer = setTimeout(() => {
            timeoutFired = true;
            controller.abort();
          }, timeout);

          const runAbortListener = runAbortSignal
            ? () => controller.abort()
            : null;
          if (runAbortSignal && runAbortListener) {
            runAbortSignal.addEventListener('abort', runAbortListener, { once: true });
            if (runAbortSignal.aborted) {
              runAbortListener();
            }
          }

          try {
            response = await fetch(currentUrl, {
              method,
              headers: fetchHeaders,
              body: method !== 'GET' && method !== 'HEAD' ? (body || undefined) : undefined,
              signal: controller.signal,
              redirect: effectiveRedirect,
            });
            clearTimeout(timer);
            if (runAbortSignal && runAbortListener) {
              runAbortSignal.removeEventListener('abort', runAbortListener);
            }

            // A 3xx is a routing answer, not a failure — never retry it.
            if (response.ok || isRedirectStatus(response.status) || (response.status >= 400 && response.status < 500)) break;

            if (runAbortSignal?.aborted) {
              const err: Error & { name: string } = new Error('fetch_url aborted between retries');
              err.name = 'AbortError';
              throw err;
            }
            if (attempt < MAX_RETRIES) {
              console.log('[fetch_url]', `fetch_url ${method} ${currentUrl} → ${response.status}, retrying (${attempt + 1}/${MAX_RETRIES})`);
              await new Promise(r => setTimeout(r, BACKOFF[attempt] || 5_000));
            }
          } catch (retryErr: any) {
            clearTimeout(timer);
            if (runAbortSignal && runAbortListener) {
              runAbortSignal.removeEventListener('abort', runAbortListener);
            }
            if (retryErr.name === 'AbortError' || attempt >= MAX_RETRIES) throw retryErr;
            console.log('[fetch_url]', `fetch_url ${method} ${currentUrl} → error, retrying (${attempt + 1}/${MAX_RETRIES}): ${retryErr.message}`);
            await new Promise(r => setTimeout(r, BACKOFF[attempt] || 5_000));
          }
        }

        if (!response) throw new Error('No response after retries');

        if (!isRedirectStatus(response.status)) break;
        // Caller opted out of following, or the response carries no target:
        // hand the 3xx back verbatim (this is also the pre-existing behaviour
        // for a credentialed internal request).
        if (!followRedirects || attachedInternalAuth) break;
        const location = response.headers.get('location');
        if (!location) break;

        if (hop >= MAX_REDIRECT_HOPS) {
          throw new SsrfBlockedError(
            'BLOCKED_TOO_MANY_REDIRECTS',
            `Too many redirects (limit ${MAX_REDIRECT_HOPS}) starting from ${url}`,
            currentUrl,
          );
        }

        // Re-runs the private-address check on the hop target.
        const nextUrl = await assertPublicRedirect(currentUrl, location, {
          trusted: !callerIsUntrusted,
        });
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          body = null;
        }
        currentUrl = nextUrl;
      }

      if (!response) throw new Error('No response after retries');

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const contentType = response.headers.get('content-type') || '';
      let responseBody = '';
      if (method !== 'HEAD') {
        responseBody = await response.text();
      }

      let output: string = responseBody;
      let pageTitle: string | undefined = undefined;

      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
      const isJson = contentType.includes('application/json');

      if (format === 'markdown' || (format === 'auto' && isHtml)) {
        const parsed = parseHtml(responseBody, currentUrl);
        output = parsed.text;
        pageTitle = parsed.title;
      } else if (format === 'json' || (format === 'auto' && isJson)) {
        try {
          const json = JSON.parse(responseBody);
          output = JSON.stringify(json, null, 2);
        } catch {
          output = responseBody;
        }
      } else if (format === 'text') {
        if (isHtml) {
          const parsed = parseHtml(responseBody, currentUrl);
          output = parsed.text;
          pageTitle = parsed.title;
        } else {
          output = responseBody;
        }
      } else {
        output = responseBody;
      }

      if (output.length > 500000) {
        output = output.slice(0, 500000) + '...(truncated)';
      }

      console.log('[fetch_url]', `fetch_url ${method} ${currentUrl} → ${response.status}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            title: pageTitle || undefined,
            contentType: contentType || undefined,
            headers: responseHeaders,
            body: output,
          }),
        }],
      };
    } catch (error: any) {
      // A refused URL is a policy decision, not a transport failure — report it
      // with its own code so the model can tell "you may not go there" from
      // "the site was down", and so the run archive shows the block.
      if (error instanceof SsrfBlockedError) {
        console.warn('[fetch_url]', `BLOCKED ${error.code}: ${error.message}`);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: error.message, code: error.code }) }],
          isError: true,
        };
      }

      let errorMessage: string;
      if (error.name === 'AbortError') {
        if (runAbortSignal?.aborted) {
          errorMessage = 'fetch_url aborted by caller';
        } else if (timeoutFired) {
          errorMessage = `Request timed out after ${timeout}ms`;
        } else {
          errorMessage = error.message || 'Request aborted (unknown source)';
        }
      } else {
        errorMessage = error.message || 'Unknown error';
      }

      console.log('[fetch_url]', `fetch_url ${method} ${url} → ERROR: ${errorMessage}`);

      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `HTTP request failed: ${errorMessage}` }) }],
        isError: true,
      };
    }
  },
};

export default fetchUrlTool;
module.exports = fetchUrlTool;
