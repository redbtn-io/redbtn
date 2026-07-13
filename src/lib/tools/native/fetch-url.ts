import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { isInternalHost } from './_internal-hosts';
import { buildHeaders } from './_task-helpers';

type AnyObject = Record<string, unknown>;

// Hard cap on bytes read from the response body, mirroring download-file.ts's
// streaming-with-cap pattern. `response.text()` buffers the ENTIRE body into
// memory before the 500,000-character display truncation below ever runs —
// against an arbitrary attacker-controlled URL (fetch_url's whole purpose),
// an oversized or slow-drip response is a memory-exhaustion vector. This cap
// is read at the byte level and is intentionally well above the 500,000-char
// display truncation (worst-case ~4 bytes/char in UTF-8) so it only ever
// kicks in for genuinely oversized bodies, not ordinary large-but-legitimate
// responses.
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024; // 8 MB

const fetchUrlTool: NativeToolDefinition = {
  description: 'Make an HTTP request to a URL. Supports all REST methods with custom headers, body, auth, and redirect control. Returns status, response headers, and body.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        description: 'HTTP method (default: GET)',
      },
      headers: {
        type: 'object',
        description: 'Request headers as key-value pairs',
        additionalProperties: { type: 'string' },
      },
      body: {
        type: 'string',
        description: 'Request body (JSON string for POST/PUT, or raw text)',
      },
      timeout: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 300000, max: 900000)',
      },
      followRedirects: {
        type: 'boolean',
        description: 'Follow HTTP redirects (default: true)',
      },
    },
    required: ['url'],
  },

  async handler(args: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const url = (args.url as string || '').trim();
    const method = ((args.method as string) || 'GET').toUpperCase();
    const headers = (args.headers as Record<string, string>) || {};
    const body = args.body as string | undefined;
    const timeout = Math.min(Number(args.timeout) || 300000, 900000);
    const followRedirects = args.followRedirects !== false;

    if (!url) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'No URL provided' }) }], isError: true };
    }

    const { publisher } = context;
    console.log('[fetch_url]', `fetch_url ${method} ${url}`);

    // Pull the run-level abort signal so external interrupt cancels the
    // in-flight HTTP request immediately (fetch supports AbortSignal natively).
    // We chain the per-request timeout AbortController to the run signal so
    // either source can cancel.
    //
    // Hoisted above the try/catch (instead of declared inside) so the catch
    // block can read both `runAbortSignal.aborted` and `timeoutFired` to
    // distinguish abort sources. Without this, every AbortError is reported
    // as "Request timed out after Xms" — even when the run was interrupted
    // in the first 100ms by an external signal.
    const runAbortSignal = context?.abortSignal || null;

    // Set by the per-attempt timer when (and only when) the timeout actually
    // fires. The run-signal abort path leaves this false.
    let timeoutFired = false;

    try {
      const fetchHeaders: Record<string, string> = { ...headers };
      if (body && !fetchHeaders['Content-Type'] && !fetchHeaders['content-type']) {
        fetchHeaders['Content-Type'] = 'application/json';
      }

      // ── Internal-platform auth ───────────────────────────────────────────
      // When the target is an allowlisted internal redbtn host, transparently
      // attach the calling run owner's credentials (Bearer JWT / X-User-Id,
      // resolved from the run context via the shared buildHeaders pattern) so
      // the request is authorized as the run owner — agents can call platform
      // APIs without minting a JWT or touching the DB.
      //
      // SECURITY: credentials are attached ONLY inside this branch. Every
      // other host falls through untouched — the run owner's session must
      // never leak to a third party. A header the caller set explicitly is
      // never overwritten (case-insensitive check), so an explicit
      // Authorization header always wins.
      //
      // SECURITY (redirect hop): `isInternalHost` is only checked against
      // THIS url. `fetch()`'s automatic redirect-follow forwards `X-User-Id` /
      // `X-Internal-Key` on cross-origin hops (they're plain headers, not on
      // the fetch spec's cross-origin-strip list the way `Authorization` is —
      // verified empirically). If the internal host ever has an open-redirect
      // endpoint, that forwards the run owner's identity AND the shared
      // service secret to whatever the redirect points to. So the moment we
      // attach internal auth we force manual redirect handling for this
      // request, regardless of the caller's `followRedirects` — the 3xx comes
      // back to the caller as-is instead of being auto-followed. A caller
      // that wants the redirect target's content issues it as a fresh
      // fetch_url call, which re-checks isInternalHost on the NEW url and
      // only reattaches credentials if that host is internal too.
      let attachedInternalAuth = false;
      if (isInternalHost(url)) {
        const hasHeader = (name: string): boolean => {
          const lower = name.toLowerCase();
          return Object.keys(fetchHeaders).some(h => h.toLowerCase() === lower);
        };
        const authHeaders = buildHeaders(context);
        for (const key of ['Authorization', 'X-User-Id', 'X-Internal-Key'] as const) {
          const value = authHeaders[key];
          if (value && !hasHeader(key)) {
            fetchHeaders[key] = value;
            attachedInternalAuth = true;
          }
        }
      }
      const effectiveRedirect = attachedInternalAuth ? 'manual' : (followRedirects ? 'follow' : 'manual');

      const MAX_RETRIES = 2;
      const BACKOFF = [2_000, 5_000];
      let response: Response | null = null;

      // Pre-aborted check
      if (runAbortSignal?.aborted) {
        const err: Error & { name: string } = new Error('fetch_url aborted before send');
        err.name = 'AbortError';
        throw err;
      }

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          timeoutFired = true;
          controller.abort();
        }, timeout);
        // Forward run abort to this request's controller
        const runAbortListener = runAbortSignal
          ? () => controller.abort()
          : null;
        if (runAbortSignal && runAbortListener) {
          runAbortSignal.addEventListener('abort', runAbortListener, { once: true });
        }

        try {
          response = await fetch(url, {
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

          // Don't retry on success or client errors (4xx)
          if (response.ok || (response.status >= 400 && response.status < 500)) break;

          // Server error (5xx) — retry, but bail immediately if run was aborted.
          if (runAbortSignal?.aborted) {
            const err: Error & { name: string } = new Error('fetch_url aborted between retries');
            err.name = 'AbortError';
            throw err;
          }
          if (attempt < MAX_RETRIES) {
            console.log('[fetch_url]', `fetch_url ${method} ${url} → ${response.status}, retrying (${attempt + 1}/${MAX_RETRIES})`);
            await new Promise(r => setTimeout(r, BACKOFF[attempt] || 5_000));
          }
        } catch (retryErr: any) {
          clearTimeout(timer);
          if (runAbortSignal && runAbortListener) {
            runAbortSignal.removeEventListener('abort', runAbortListener);
          }
          // AbortError (from either timeout or run signal) is terminal.
          if (retryErr.name === 'AbortError' || attempt >= MAX_RETRIES) throw retryErr;
          console.log('[fetch_url]', `fetch_url ${method} ${url} → error, retrying (${attempt + 1}/${MAX_RETRIES}): ${retryErr.message}`);
          await new Promise(r => setTimeout(r, BACKOFF[attempt] || 5_000));
        }
      }

      if (!response) throw new Error('No response after retries');

      // Collect response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // HEAD and OPTIONS don't need body. Stream + cap instead of
      // response.text() (which buffers the whole body into memory before
      // ANY size check runs) — see MAX_RESPONSE_BODY_BYTES above.
      let responseBody = '';
      let bodyCapped = false;
      if (method !== 'HEAD') {
        const bodyStream = response.body;
        if (bodyStream) {
          const reader = bodyStream.getReader();
          const chunks: Uint8Array[] = [];
          let received = 0;
          try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) {
                received += value.byteLength;
                if (received > MAX_RESPONSE_BODY_BYTES) {
                  bodyCapped = true;
                  try {
                    await reader.cancel();
                  } catch {
                    /* ignore */
                  }
                  break;
                }
                chunks.push(value);
              }
            }
          } finally {
            try {
              reader.releaseLock();
            } catch {
              /* ignore */
            }
          }
          responseBody = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
        } else {
          // Some fetch implementations / mocks return no streamable body —
          // fall back to the buffered path and cap after the fact.
          const full = await response.text();
          if (Buffer.byteLength(full, 'utf8') > MAX_RESPONSE_BODY_BYTES) {
            bodyCapped = true;
            responseBody = Buffer.from(full, 'utf8').subarray(0, MAX_RESPONSE_BODY_BYTES).toString('utf8');
          } else {
            responseBody = full;
          }
        }
      }

      // Try to pretty-print JSON
      let output: string;
      try {
        const json = JSON.parse(responseBody);
        output = JSON.stringify(json, null, 2);
      } catch {
        output = responseBody;
      }

      // Truncate large responses
      if (output.length > 500000) {
        output = output.slice(0, 500000) + '...(truncated)';
      } else if (bodyCapped) {
        output += `...(truncated - response body exceeded ${MAX_RESPONSE_BODY_BYTES} bytes)`;
      }

      console.log('[fetch_url]', `fetch_url ${method} ${url} → ${response.status}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: output,
          }),
        }],
      };
    } catch (error: any) {
      // Distinguish abort sources for an accurate error message:
      //   - run-level abort (external interrupt)  → "aborted by caller"
      //   - per-attempt timer fired              → "timed out after Xms"
      //   - everything else                       → fall back to error.message
      //
      // The run signal takes precedence: if BOTH the timer and the run signal
      // are aborted (e.g. timer fires a moment after a run abort), we still
      // report the higher-level cause that the caller actually triggered.
      let errorMessage: string;
      if (error.name === 'AbortError') {
        if (runAbortSignal?.aborted) {
          errorMessage = 'fetch_url aborted by caller';
        } else if (timeoutFired) {
          errorMessage = `Request timed out after ${timeout}ms`;
        } else {
          // Aborted but neither source flag is set — surface the original
          // message so post-mortems aren't lying about the cause.
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
