/**
 * Command executor
 * Executes shell commands with timeout and output limits
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const MAX_OUTPUT_LENGTH = 4096; // 4KB

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

/**
 * Execute a shell command
 */
export async function executeCommand(
  command: string,
  timeout: number = DEFAULT_TIMEOUT,
  onOutput?: (data: string) => void
): Promise<ExecutionResult> {
  const startTime = Date.now();
  
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      maxBuffer: MAX_OUTPUT_LENGTH * 2, // Allow 2x max for internal buffer
      shell: '/bin/bash',
      env: {
        ...process.env,
        // Ensure clean environment
        PATH: process.env.PATH,
      },
    });

    const duration = Date.now() - startTime;
    
    // Truncate outputs if too long
    let finalStdout = stdout;
    let finalStderr = stderr;
    let outputTruncated = false;

    if (finalStdout.length > MAX_OUTPUT_LENGTH) {
      finalStdout = finalStdout.substring(0, MAX_OUTPUT_LENGTH) + 
        '\n\n[Output truncated - too long]';
      outputTruncated = true;
    }

    if (finalStderr.length > MAX_OUTPUT_LENGTH) {
      finalStderr = finalStderr.substring(0, MAX_OUTPUT_LENGTH) + 
        '\n\n[Error output truncated - too long]';
      outputTruncated = true;
    }

    // Call output callback if provided (for streaming updates)
    if (onOutput && finalStdout) {
      onOutput(finalStdout);
    }

    return {
      stdout: finalStdout,
      stderr: finalStderr,
      exitCode: 0,
      duration,
      timedOut: false,
      outputTruncated,
    };

  } catch (error: any) {
    const duration = Date.now() - startTime;
    
    // Check if it was a timeout
    if (error.killed && error.signal === 'SIGTERM') {
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || `Command timeout after ${timeout}ms`,
        exitCode: -1,
        duration,
        timedOut: true,
        outputTruncated: false,
      };
    }

    // Command executed but returned non-zero exit code
    if (error.code !== undefined) {
      let stdout = error.stdout || '';
      let stderr = error.stderr || '';
      let outputTruncated = false;

      if (stdout.length > MAX_OUTPUT_LENGTH) {
        stdout = stdout.substring(0, MAX_OUTPUT_LENGTH) + '\n\n[Output truncated]';
        outputTruncated = true;
      }

      if (stderr.length > MAX_OUTPUT_LENGTH) {
        stderr = stderr.substring(0, MAX_OUTPUT_LENGTH) + '\n\n[Error output truncated]';
        outputTruncated = true;
      }

      return {
        stdout,
        stderr,
        exitCode: error.code,
        duration,
        timedOut: false,
        outputTruncated,
      };
    }

    // Unknown error
    throw error;
  }
}
