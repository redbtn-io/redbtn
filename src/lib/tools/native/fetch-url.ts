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
    publisher?.emit('log', `fetch_url ${method} ${url}`);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const fetchHeaders: Record<string, string> = { ...headers };
      if (body && !fetchHeaders['Content-Type'] && !fetchHeaders['content-type']) {
        fetchHeaders['Content-Type'] = 'application/json';
      }

      const response = await fetch(url, {
        method,
        headers: fetchHeaders,
        body: method !== 'GET' && method !== 'HEAD' ? (body || undefined) : undefined,
        signal: controller.signal,
        redirect: followRedirects ? 'follow' : 'manual',
      });

      clearTimeout(timer);

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

      publisher?.emit('log', `fetch_url ${method} ${url} → ${response.status}`);

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
      const errorMessage = error.name === 'AbortError'
        ? `Request timed out after ${timeout}ms`
        : error.message || 'Unknown error';

      publisher?.emit('log', `fetch_url ${method} ${url} → ERROR: ${errorMessage}`);

      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `HTTP request failed: ${errorMessage}` }) }],
        isError: true,
      };
    }
  },
};

export default fetchUrlTool;
