/**
 * Send Webhook — Native Notifications Tool
 *
 * Sends an outbound HTTP request to an arbitrary URL — typically an external
 * webhook listener (Slack, Discord, Zapier, custom backend). Distinct from
 * `fetch_url` in three ways:
 *   1. Defaults to POST and JSON content-type.
 *   2. Auto-serialises object bodies to JSON.
 *   3. Returns a notifications-shaped envelope `{ status, response }` rather
 *      than the full HTTP debug payload from `fetch_url`.
 *
 * Spec: TOOL-HANDOFF.md §4.13
 *   - inputs: url, method? (default 'POST'), headers?, body?
 *   - output: { status, response }
 *
 * Body handling:
 *   - object / array → JSON.stringify, Content-Type defaults to application/json
 *   - string         → sent verbatim, Content-Type defaults to application/json
 *                       only if the string parses as JSON, otherwise text/plain
 *   - undefined      → no body
 *
 * Response handling:
 *   - JSON-shaped responses are parsed; everything else is returned as a string.
 *   - Bodies > 100KB are truncated with a `truncated: true` marker.
 *
 * Non-2xx responses surface as `isError: true` with the status + response body
 * forwarded so the caller can react. Network errors (DNS / refused / timeout)
 * surface as `isError: true` with `error` set to the underlying message.
 *
 * The run-level abort signal is honoured — if the run is interrupted while
 * the webhook is in flight, the request is cancelled.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface SendWebhookArgs {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RESPONSE_BYTES = 100_000;

const ALLOWED_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

/** Try to parse a JSON string; on failure, return null. */
function tryParseJson(s: string): unknown | null {
  if (!s) return null;
  // Cheap heuristic — only attempt parse if it starts with object/array/quote/etc.
  const head = s.trimStart()[0];
  if (head !== '{' && head !== '[' && head !== '"' && head !== 't' && head !== 'f' && head !== 'n' && (head < '0' || head > '9') && head !== '-') {
    return null;
  }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const sendWebhookTool: NativeToolDefinition = {
  description:
    'Send an outbound HTTP request to a webhook URL. Defaults to POST with ' +
    'application/json content-type when body is an object. Returns ' +
    '{ status, response } where response is the parsed JSON body when possible, ' +
    'or the raw text otherwise. Non-2xx surfaces as an error but still includes ' +
    'the response body for inspection. Honours the run-level abort signal.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The webhook URL to POST/GET/etc. Required.',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        description: "HTTP method (default 'POST').",
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Additional request headers as key-value pairs.',
      },
      body: {
        description:
          'Request body. Objects/arrays are JSON-serialised and sent with ' +
          'Content-Type: application/json (overridable via headers). Strings are ' +
          'sent verbatim. Omit for GET/HEAD.',
      },
      timeout: {
        type: 'integer',
        description: `Request timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
      },
    },
    required: ['url'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<SendWebhookArgs>;
    const url = typeof args.url === 'string' ? args.url.trim() : '';

    if (!url) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'url is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    // Validate URL parses + has http(s) protocol.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Invalid URL: ${url}`,
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `URL protocol must be http or https, got '${parsedUrl.protocol}'`,
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    // Normalise + validate method.
    const method = (typeof args.method === 'string' ? args.method.trim() : 'POST').toUpperCase() || 'POST';
    if (!ALLOWED_METHODS.has(method)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Invalid method: must be one of ${[...ALLOWED_METHODS].join(', ')}`,
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const timeout = (() => {
      const raw = Number(args.timeout);
      if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
      return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(raw)));
    })();

    // Caller-supplied headers are normalised case-insensitively so we can
    // detect & override Content-Type when the body is structured.
    const callerHeaders: Record<string, string> = {};
    if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
      for (const [k, v] of Object.entries(args.headers)) {
        if (typeof k === 'string' && typeof v === 'string') callerHeaders[k] = v;
      }
    }
    const lowerHeaderKeys = new Set(
      Object.keys(callerHeaders).map((k) => k.toLowerCase()),
    );

    // Body serialisation — only meaningful for non-GET/HEAD methods.
    let serialisedBody: string | undefined;
    let inferredContentType: string | undefined;
    if (method !== 'GET' && method !== 'HEAD' && args.body !== undefined && args.body !== null) {
      if (typeof args.body === 'string') {
        serialisedBody = args.body;
        inferredContentType = tryParseJson(args.body) !== null ? 'application/json' : 'text/plain; charset=utf-8';
      } else if (typeof args.body === 'object') {
        try {
          serialisedBody = JSON.stringify(args.body);
          inferredContentType = 'application/json';
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `body could not be serialised to JSON: ${msg}`,
                  code: 'VALIDATION',
                }),
              },
            ],
            isError: true,
          };
        }
      } else {
        // Number, boolean, etc. — coerce to string.
        serialisedBody = String(args.body);
        inferredContentType = 'text/plain; charset=utf-8';
      }
    }

    const finalHeaders: Record<string, string> = { ...callerHeaders };
    if (serialisedBody !== undefined && !lowerHeaderKeys.has('content-type') && inferredContentType) {
      finalHeaders['Content-Type'] = inferredContentType;
    }

    // Hook the run-level abort signal so an external interrupt cancels in-flight.
    const runAbortSignal = context?.abortSignal || null;
    const controller = new AbortController();
    let timeoutFired = false;
    const timer = setTimeout(() => {
      timeoutFired = true;
      controller.abort();
    }, timeout);
    const onRunAbort = runAbortSignal ? () => controller.abort() : null;
    if (runAbortSignal && onRunAbort) {
      if (runAbortSignal.aborted) {
        clearTimeout(timer);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'send_webhook aborted before send' }),
            },
          ],
          isError: true,
        };
      }
      runAbortSignal.addEventListener('abort', onRunAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: finalHeaders,
        body: serialisedBody,
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (runAbortSignal && onRunAbort) runAbortSignal.removeEventListener('abort', onRunAbort);
      const e = err as { name?: string; message?: string };
      let message: string;
      if (e?.name === 'AbortError') {
        if (runAbortSignal?.aborted) message = 'send_webhook aborted by caller';
        else if (timeoutFired) message = `send_webhook timed out after ${timeout}ms`;
        else message = e?.message || 'send_webhook aborted (unknown source)';
      } else {
        message = e?.message || String(err);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message, url, method }) }],
        isError: true,
      };
    }
    clearTimeout(timer);
    if (runAbortSignal && onRunAbort) runAbortSignal.removeEventListener('abort', onRunAbort);

    // Read response body. HEAD has no body so skip the read.
    let rawText = '';
    if (method !== 'HEAD') {
      try {
        rawText = await response.text();
      } catch {
        rawText = '';
      }
    }

    const truncated = rawText.length > MAX_RESPONSE_BYTES;
    const bodyText = truncated ? rawText.slice(0, MAX_RESPONSE_BYTES) : rawText;
    const parsed = tryParseJson(bodyText);

    const responsePayload: AnyObject = {
      status: response.status,
      statusText: response.statusText,
      url,
      method,
      response: parsed !== null ? parsed : bodyText,
    };
    if (truncated) responsePayload.truncated = true;

    if (!response.ok) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...responsePayload,
              error: `Webhook returned ${response.status} ${response.statusText}`,
            }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(responsePayload) }],
    };
  },
};

export default sendWebhookTool;
module.exports = sendWebhookTool;
