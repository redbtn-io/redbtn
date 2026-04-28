import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';

type AnyObject = Record<string, unknown>;

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
            redirect: followRedirects ? 'follow' : 'manual',
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

      // HEAD and OPTIONS don't need body
      let responseBody = '';
      if (method !== 'HEAD') {
        responseBody = await response.text();
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
