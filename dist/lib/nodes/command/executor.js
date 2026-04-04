"use strict";
/**
 * Command executor
 * Executes shell commands with timeout and output limits
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeCommand = executeCommand;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const MAX_OUTPUT_LENGTH = 4096; // 4KB
/**
 * Execute a shell command
 */
function executeCommand(command_1) {
    return __awaiter(this, arguments, void 0, function* (command, timeout = DEFAULT_TIMEOUT, onOutput) {
        const startTime = Date.now();
        try {
            const { stdout, stderr } = yield execAsync(command, {
                timeout,
                maxBuffer: MAX_OUTPUT_LENGTH * 2, // Allow 2x max for internal buffer
                shell: '/bin/bash',
                env: Object.assign(Object.assign({}, process.env), { 
                    // Ensure clean environment
                    PATH: process.env.PATH }),
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
        }
        catch (error) {
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
    });
}
