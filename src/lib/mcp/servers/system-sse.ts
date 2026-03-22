/**
 * System MCP Server - SSE Transport
 * Provides system command execution capabilities
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { McpServerSSE } from '../server-sse';
import { CallToolResult } from '../types';

const execAsync = promisify(exec);

export class SystemServerSSE extends McpServerSSE {
  private allowedCommands: string[];
  private workingDirectory: string;

  constructor(
    name: string,
    version: string,
    port: number = 3002,
    options?: {
      allowedCommands?: string[];
      workingDirectory?: string;
    }
  ) {
    super(name, version, port, '/mcp');

    // Default to safe commands only
    this.allowedCommands = options?.allowedCommands || [
      'ls', 'cat', 'pwd', 'echo', 'date', 'whoami',
      'find', 'grep', 'head', 'tail', 'wc', 'df', 'du',
      'git', 'npm', 'node', 'python', 'node'
    ];

    this.workingDirectory = options?.workingDirectory || process.cwd();
  }

  /**
   * Setup tools
   */
  protected async setup(): Promise<void> {
    this.defineTool({
      name: 'execute_command',
      description: `Execute a system command. Allowed commands: ${this.allowedCommands.join(', ')}. Returns the command output (stdout and stderr).`,
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The command to execute (must start with an allowed command)'
          }
        },
        required: ['command']
      }
    });

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
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    if (name === 'execute_command') {
      return await this.executeCommand(args, meta);
    }
    if (name === 'fetch_url') {
      return await this.fetchUrl(args);
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Execute system command
   */
  private async executeCommand(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const command = (args.command as string || '').trim();

    if (!command) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'No command provided' })
        }],
        isError: true
      };
    }

    // Check if command starts with an allowed command
    const commandBase = command.split(/\s+/)[0];
    const isAllowed = this.allowedCommands.some(allowed =>
      commandBase === allowed || commandBase.endsWith(`/${allowed}`)
    );

    if (!isAllowed) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Command not allowed: ${commandBase}`,
            allowedCommands: this.allowedCommands
          })
        }],
        isError: true
      };
    }

    // Execute command
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workingDirectory,
        timeout: 30000,  // 30 second timeout
        maxBuffer: 10 * 1024 * 1024  // 10MB max output
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            command,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            success: true
          })
        }]
      };

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            command,
            stdout: error.stdout?.trim() || '',
            stderr: error.stderr?.trim() || error.message,
            exitCode: error.code,
            success: false
          })
        }],
        isError: true
      };
    }
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
