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
}
