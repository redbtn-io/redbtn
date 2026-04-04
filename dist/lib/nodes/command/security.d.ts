/**
 * Command security validator
 * Prevents execution of dangerous commands
 */
export declare class SecurityError extends Error {
    constructor(message: string);
}
/**
 * Validate a command for security
 * Throws SecurityError if command is dangerous
 */
export declare function validateCommand(command: string): void;
