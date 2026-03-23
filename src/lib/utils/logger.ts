/**
 * Logging utility for the AI package
 *
 * Provides structured logging with log levels, namespaces, and optional
 * suppression of verbose logs in production. Uses environment variable
 * LOG_LEVEL to control verbosity.
 *
 * Levels: error(0) < warn(1) < info(2) < debug(3) < trace(4)
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4,
}

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.TRACE]: 'TRACE',
};

/**
 * Get current log level from environment
 */
function getCurrentLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.toUpperCase();
  switch (level) {
    case 'ERROR': return LogLevel.ERROR;
    case 'WARN': return LogLevel.WARN;
    case 'INFO': return LogLevel.INFO;
    case 'DEBUG': return LogLevel.DEBUG;
    case 'TRACE': return LogLevel.TRACE;
    default:
      // Default to INFO in production, DEBUG in development
      return process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG;
  }
}

/**
 * Format a log message with timestamp and namespace
 */
function formatMessage(level: LogLevel, namespace: string, message: string): string {
  const timestamp = new Date().toISOString();
  const levelName = LOG_LEVEL_NAMES[level];
  return `[${timestamp}] [${levelName}] [${namespace}] ${message}`;
}

/**
 * Create a namespaced logger
 * @param namespace Logger namespace (e.g., 'NeuronRegistry', 'GraphCompiler')
 * @returns Logger object with level-specific methods
 */
export function createLogger(namespace: string) {
  const currentLevel = getCurrentLogLevel();
  return {
    /**
     * Log an error message (always logged)
     */
    error(message: string, ...args: unknown[]): void {
      if (currentLevel >= LogLevel.ERROR) {
        console.error(formatMessage(LogLevel.ERROR, namespace, message), ...args);
      }
    },
    /**
     * Log a warning message
     */
    warn(message: string, ...args: unknown[]): void {
      if (currentLevel >= LogLevel.WARN) {
        console.warn(formatMessage(LogLevel.WARN, namespace, message), ...args);
      }
    },
    /**
     * Log an info message (default level)
     */
    info(message: string, ...args: unknown[]): void {
      if (currentLevel >= LogLevel.INFO) {
        console.log(formatMessage(LogLevel.INFO, namespace, message), ...args);
      }
    },
    /**
     * Log a debug message (development only by default)
     */
    debug(message: string, ...args: unknown[]): void {
      if (currentLevel >= LogLevel.DEBUG) {
        console.log(formatMessage(LogLevel.DEBUG, namespace, message), ...args);
      }
    },
    /**
     * Log a trace message (very verbose, must be explicitly enabled)
     */
    trace(message: string, ...args: unknown[]): void {
      if (currentLevel >= LogLevel.TRACE) {
        console.log(formatMessage(LogLevel.TRACE, namespace, message), ...args);
      }
    },
    /**
     * Check if a log level is enabled
     */
    isEnabled(level: LogLevel): boolean {
      return currentLevel >= level;
    },
  };
}

/**
 * Default logger for quick usage
 */
export const log = createLogger('AI');

export type Logger = ReturnType<typeof createLogger>;
