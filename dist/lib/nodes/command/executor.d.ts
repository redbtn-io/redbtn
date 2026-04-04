/**
 * Command executor
 * Executes shell commands with timeout and output limits
 */
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
export declare function executeCommand(command: string, timeout?: number, onOutput?: (data: string) => void): Promise<ExecutionResult>;
