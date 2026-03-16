/**
 * System MCP Server
 * Provides system command execution capabilities
 */

import { Redis } from 'ioredis';
import { exec } from 'child_process';
import { promisify } from 'util';
import { McpServer } from '../server';
import { CallToolResult } from '../types';
import { McpEventPublisher } from '../event-publisher';

const execAsync = promisify(exec);

export class SystemServer extends McpServer {
  private allowedCommands: string[];
  private workingDirectory: string;

  constructor(
    redis: Redis,
    options?: {
      allowedCommands?: string[];
      workingDirectory?: string;
    }
  ) {
    super(redis, 'system', '1.0.0');
    
    // Default to safe commands only
    this.allowedCommands = options?.allowedCommands || [
      'ls', 'cat', 'pwd', 'echo', 'date', 'whoami',
      'find', 'grep', 'head', 'tail', 'wc', 'df', 'du',
      'git', 'npm', 'node'
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
      return await this.fetchUrl(args, meta);
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

    // Create event publisher (use publishRedis for events)
    const publisher = new McpEventPublisher(this.publishRedis, 'execute_command', 'Command Execution', meta);

    await publisher.publishStart({ input: { command: command.substring(0, 100) } });
    await publisher.publishLog('info', `⚙️ Execute command: "${command.substring(0, 100)}${command.length > 100 ? '...' : ''}"`);

    if (!command) {
      const error = 'No command provided';
      await publisher.publishError(error);
      await publisher.publishLog('error', `✗ ${error}`);
      
      return {
        content: [{
          type: 'text',
          text: `Error: ${error}`
        }],
        isError: true
      };
    }

    // Check if command is allowed
    const baseCommand = command.split(' ')[0];
    if (!this.allowedCommands.includes(baseCommand)) {
      const error = `Command '${baseCommand}' is not allowed. Allowed commands: ${this.allowedCommands.join(', ')}`;
      await publisher.publishError(error);
      await publisher.publishLog('warn', `🛡️ Security blocked: ${baseCommand}`);
      
      return {
        content: [{
          type: 'text',
          text: `Error: ${error}`
        }],
        isError: true
      };
    }

    await publisher.publishProgress('Security check passed, executing...', { progress: 30 });
    await publisher.publishLog('info', `✓ Security check passed`);

    try {
      await publisher.publishProgress(`Executing: ${command.substring(0, 60)}...`, { progress: 50 });
      
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workingDirectory,
        timeout: 30000, // 30 second timeout
        maxBuffer: 1024 * 1024, // 1MB max output
      });

      const duration = publisher.getDuration();

      let output = '';
      
      if (stdout) {
        output += `**Output:**\n\`\`\`\n${stdout}\n\`\`\`\n`;
      }
      
      if (stderr) {
        output += `**Errors:**\n\`\`\`\n${stderr}\n\`\`\`\n`;
      }

      if (!output) {
        output = '(Command executed successfully with no output)';
      }

      await publisher.publishComplete({
        stdoutLength: stdout.length,
        stderrLength: stderr.length
      }, {
        duration,
        protocol: 'MCP'
      });

      await publisher.publishLog('success', `✓ Complete in ${duration}ms - stdout: ${stdout.length} chars, stderr: ${stderr.length} chars`, {
        duration,
        stdoutLength: stdout.length,
        stderrLength: stderr.length
      });

      return {
        content: [{
          type: 'text',
          text: output
        }]
      };

    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';
      const stderr = error.stderr || '';
      const stdout = error.stdout || '';
      const duration = publisher.getDuration();

      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Command failed: ${errorMessage}`, { duration });

      let errorText = `Command execution failed: ${errorMessage}\n`;
      
      if (stdout) {
        errorText += `\n**Output:**\n\`\`\`\n${stdout}\n\`\`\`\n`;
      }
      
      if (stderr) {
        errorText += `\n**Errors:**\n\`\`\`\n${stderr}\n\`\`\``;
      }

      return {
        content: [{
          type: 'text',
          text: errorText
        }],
        isError: true
      };
    }
  }

  /**
   * Fetch a URL via HTTP
   */
  private async fetchUrl(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const url = (args.url as string || '').trim();
    const method = ((args.method as string) || 'GET').toUpperCase();
    const headers = (args.headers as Record<string, string>) || {};
    const body = args.body as string | undefined;
    const timeout = Math.min(Number(args.timeout) || 300000, 900000);

    const publisher = new McpEventPublisher(this.publishRedis, 'fetch_url', 'HTTP Request', meta);
    await publisher.publishStart({ input: { url, method } });

    if (!url) {
      const error = 'No URL provided';
      await publisher.publishError(error);
      return { content: [{ type: 'text', text: `Error: ${error}` }], isError: true };
    }

    try {
      await publisher.publishProgress(`${method} ${url}`, { progress: 30 });

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
      const duration = publisher.getDuration();

      await publisher.publishComplete(
        { status: response.status, bodyLength: responseText.length },
        { duration, protocol: 'HTTP' }
      );

      // Try to parse as JSON for cleaner output
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
      const duration = publisher.getDuration();

      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ ${method} ${url} failed: ${errorMessage}`, { duration });

      return {
        content: [{ type: 'text', text: `HTTP request failed: ${errorMessage}` }],
        isError: true
      };
    }
  }
}
