/**
 * System MCP Server
 * Provides system command execution capabilities
 */

import { Redis } from 'ioredis';
import { exec } from 'child_process';
import { promisify } from 'util';
import { McpServer } from '../server';
import { CallToolResult } from '../types';

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
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    if (name === 'execute_command') {
      return await this.executeCommand(args);
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Execute system command
   */
  private async executeCommand(args: Record<string, unknown>): Promise<CallToolResult> {
    const command = (args.command as string || '').trim();

    if (!command) {
      return {
        content: [{
          type: 'text',
          text: 'Error: No command provided'
        }],
        isError: true
      };
    }

    // Check if command is allowed
    const baseCommand = command.split(' ')[0];
    if (!this.allowedCommands.includes(baseCommand)) {
      return {
        content: [{
          type: 'text',
          text: `Error: Command '${baseCommand}' is not allowed. Allowed commands: ${this.allowedCommands.join(', ')}`
        }],
        isError: true
      };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workingDirectory,
        timeout: 30000, // 30 second timeout
        maxBuffer: 1024 * 1024, // 1MB max output
      });

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
}
