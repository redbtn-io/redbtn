/**
 * Types for the command node
 */

export interface CommandNodeInput {
  command: string;
  timeout?: number;
}

export interface CommandNodeOutput {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}
