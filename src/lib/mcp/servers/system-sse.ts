/**
 * System MCP Server - SSE Transport
 * Provides HTTP fetch capabilities. Command execution removed for security
 * — use the native ssh_shell tool for remote command execution instead.
 */

import { McpServerSSE } from '../server-sse';
import { CallToolResult } from '../types';

export class SystemServerSSE extends McpServerSSE {
  constructor(
    name: string,
    version: string,
    port: number = 3002,
  ) {
    super(name, version, port, '/mcp');
  }

  /**
   * Setup tools
   */
  protected async setup(): Promise<void> {
    this.defineTool({
      name: 'fetch_url',
      description: 'Make an HTTP request to a URL. Supports GET, POST, PUT, PATCH, DELETE with custom headers and body. Returns the response status, headers, and body.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch'
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            description: 'HTTP method (default: GET)'
          },
          headers: {
            type: 'object',
            description: 'Request headers as key-value pairs',
            additionalProperties: { type: 'string' }
          },
          body: {
            type: 'string',
            description: 'Request body (usually JSON string for POST/PUT)'
          },
          timeout: {
            type: 'number',
            description: 'Request timeout in milliseconds (default: 300000, max: 900000)'
          }
        },
        required: ['url']
      }
    });

    this.capabilities = {
      tools: {
        listChanged: false
      }
    };
  }

  /**
   * Execute tool
   */
  protected async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (name === 'fetch_url') {
      return await this.fetchUrl(args);
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Fetch a URL via HTTP
   */
  private async fetchUrl(args: Record<string, unknown>): Promise<CallToolResult> {
    const url = (args.url as string || '').trim();
    const method = ((args.method as string) || 'GET').toUpperCase();
    const headers = (args.headers as Record<string, string>) || {};
    const body = args.body as string | undefined;
    const timeout = Math.min(Number(args.timeout) || 300000, 900000);

    if (!url) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'No URL provided' }) }], isError: true };
    }

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
        body: body || undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      const responseText = await response.text();

      let output: string;
      try {
        const json = JSON.parse(responseText);
        output = JSON.stringify(json, null, 2);
      } catch {
        output = responseText;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            body: output.length > 500000 ? output.slice(0, 500000) + '...(truncated)' : output,
          })
        }]
      };
    } catch (error: any) {
      const errorMessage = error.name === 'AbortError'
        ? `Request timed out after ${timeout}ms`
        : error.message || 'Unknown error';

      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `HTTP request failed: ${errorMessage}` }) }],
        isError: true
      };
    }
  }
}
