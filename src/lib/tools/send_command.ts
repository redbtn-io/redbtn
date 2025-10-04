import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const commandSchema = z.object({
  command: z.string().describe("The CLI command to execute (e.g., 'ls -la', 'pwd', 'echo hello')"),
  timeout: z.number().optional().describe("Optional timeout in milliseconds (default: 30000)"),
});

/**
 * Send Command Tool - Executes CLI commands on the system
 * SECURITY WARNING: This tool can execute arbitrary commands. Use with caution and
 * implement proper security measures in production environments.
 */
class SendCommandTool extends StructuredTool {
  name = "send_command";
  description = "Execute a command line (CLI) command on the system. Use this to run shell commands, check system status, manage files, or interact with the operating system. Returns the command output (stdout/stderr). Use with caution as this executes real commands.";
  schema = commandSchema as any; // Type assertion to bypass deep instantiation

  async _call({ command, timeout = 30000 }: { command: string; timeout?: number }): Promise<string> {
    const startTime = Date.now();
    try {
      // Security check: block dangerous commands
      const dangerousPatterns = [
        /rm\s+-rf\s+\/($|\s)/,  // rm -rf /
        /:\(\)\{.*:\|:.*\};:/,   // fork bomb
        /mkfs\./,                 // format filesystem
        /dd\s+if=/,              // dd commands (can be dangerous)
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          return `Error: Command blocked for security reasons. This command pattern is not allowed.`;
        }
      }

      console.log(`[Send Command Tool] Executing: ${command}`);
      const execStart = Date.now();
      
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        maxBuffer: 1024 * 1024, // 1MB buffer
        shell: '/bin/bash', // Use bash for better compatibility
      });
      
      const execDuration = Date.now() - execStart;
      console.log(`[Send Command Tool] ⏱️  Command completed in ${execDuration}ms`);

      // Combine stdout and stderr
      let output = '';
      if (stdout) {
        output += stdout;
      }
      if (stderr) {
        output += (output ? '\n' : '') + `[STDERR]: ${stderr}`;
      }

      if (!output) {
        output = 'Command executed successfully with no output.';
      }

      // Truncate very long output
      if (output.length > 4000) {
        output = output.substring(0, 4000) + '\n\n... (output truncated)';
      }

      const totalDuration = Date.now() - startTime;
      console.log(`[Send Command Tool] ⏱️  Total execution time: ${totalDuration}ms`);

      return `Command: ${command}\n\nOutput:\n${output}`;
    } catch (error: any) {
      const totalDuration = Date.now() - startTime;
      console.error(`[Send Command Tool] ⏱️  Error after ${totalDuration}ms:`, error);
      
      // Handle timeout
      if (error.killed && error.signal === 'SIGTERM') {
        return `Error: Command timed out after ${timeout}ms`;
      }

      // Handle command execution errors
      let errorMessage = `Error executing command: ${command}\n\n`;
      
      if (error.stdout) {
        errorMessage += `STDOUT:\n${error.stdout}\n\n`;
      }
      
      if (error.stderr) {
        errorMessage += `STDERR:\n${error.stderr}\n\n`;
      }
      
      if (error.code) {
        errorMessage += `Exit code: ${error.code}`;
      }

      return errorMessage.trim();
    }
  }
}

export const sendCommandTool = new SendCommandTool() as any; // Type assertion for export
