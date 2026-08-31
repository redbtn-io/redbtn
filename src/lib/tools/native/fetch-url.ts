/**
 * Fetch URL — Native Tool
 *
 * Makes an HTTP request to a URL and returns the response status, headers,
 * and body. Features:
 *   - Modern browser emulation headers by default
 *   - Auto-formatting for JSON and HTML (converts HTML to clean Markdown)
 *   - Configurable format ('auto', 'markdown', 'json', 'text', 'raw')
 *   - Internal-platform auth forwarding for allowlisted redbtn hosts
 *   - Robust retry and abort signal support
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { isInternalHost } from './_internal-hosts';
import { buildHeaders } from './_task-helpers';
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
    'Fetch content from a URL or make an HTTP API call. Returns status code, headers, title, and body (automatically converted to clean Markdown for HTML pages or pretty JSON for APIs).',
  server: 'web',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch (must start with http:// or https://).',
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
        description: 'Whether to automatically follow HTTP redirects (default true).',
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
    const method = (typeof args.method === 'string' ? args.method.toUpperCase() : 'GET') as
      | 'GET'
      | 'POST'
      | 'PUT'
      | 'PATCH'
      | 'DELETE'
      | 'HEAD'
      | 'OPTIONS';
    const headers = (args.headers && typeof args.headers === 'object' ? args.headers : {}) as Record<string, string>;
    const body = typeof args.body === 'string' ? args.body : null;
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

    try {
      const fetchHeaders: Record<string, string> = {
        ...DEFAULT_BROWSER_HEADERS,
        ...headers,
      };

      if (body && !fetchHeaders['Content-Type'] && !fetchHeaders['content-type']) {
        fetchHeaders['Content-Type'] = 'application/json';
      }

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

      const effectiveRedirect = attachedInternalAuth
        ? 'manual'
        : (followRedirects ? 'follow' : 'manual');

      const MAX_RETRIES = 2;
      const BACKOFF = [2_000, 5_000];
      let response: Response | null = null;

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

          if (response.ok || (response.status >= 400 && response.status < 500)) break;

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
          if (retryErr.name === 'AbortError' || attempt >= MAX_RETRIES) throw retryErr;
          console.log('[fetch_url]', `fetch_url ${method} ${url} → error, retrying (${attempt + 1}/${MAX_RETRIES}): ${retryErr.message}`);
          await new Promise(r => setTimeout(r, BACKOFF[attempt] || 5_000));
        }
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
        const parsed = parseHtml(responseBody, url);
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
          const parsed = parseHtml(responseBody, url);
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

      console.log('[fetch_url]', `fetch_url ${method} ${url} → ${response.status}`);

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
