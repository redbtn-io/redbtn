/**
 * Logging utility for the AI package
 *
 * Provides structured logging with log levels, namespaces, and optional
 * suppression of verbose logs in production. Uses environment variable
 * LOG_LEVEL to control verbosity.
 *
 * Levels: error(0) < warn(1) < info(2) < debug(3) < trace(4)
 */
export declare enum LogLevel {
    ERROR = 0,
    WARN = 1,
    INFO = 2,
    DEBUG = 3,
    TRACE = 4
}
/**
 * Create a namespaced logger
 * @param namespace Logger namespace (e.g., 'NeuronRegistry', 'GraphCompiler')
 * @returns Logger object with level-specific methods
 */
export declare function createLogger(namespace: string): {
    /**
     * Log an error message (always logged)
     */
    error(message: string, ...args: unknown[]): void;
    /**
     * Log a warning message
     */
    warn(message: string, ...args: unknown[]): void;
    /**
     * Log an info message (default level)
     */
    info(message: string, ...args: unknown[]): void;
    /**
     * Log a debug message (development only by default)
     */
    debug(message: string, ...args: unknown[]): void;
    /**
     * Log a trace message (very verbose, must be explicitly enabled)
     */
    trace(message: string, ...args: unknown[]): void;
    /**
     * Check if a log level is enabled
     */
    isEnabled(level: LogLevel): boolean;
};
/**
 * Default logger for quick usage
 */
export declare const log: {
    /**
     * Log an error message (always logged)
     */
    error(message: string, ...args: unknown[]): void;
    /**
     * Log a warning message
     */
    warn(message: string, ...args: unknown[]): void;
    /**
     * Log an info message (default level)
     */
    info(message: string, ...args: unknown[]): void;
    /**
     * Log a debug message (development only by default)
     */
    debug(message: string, ...args: unknown[]): void;
    /**
     * Log a trace message (very verbose, must be explicitly enabled)
     */
    trace(message: string, ...args: unknown[]): void;
    /**
     * Check if a log level is enabled
     */
    isEnabled(level: LogLevel): boolean;
};
export type Logger = ReturnType<typeof createLogger>;
