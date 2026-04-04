"use strict";
/**
 * Logging utility for the AI package
 *
 * Provides structured logging with log levels, namespaces, and optional
 * suppression of verbose logs in production. Uses environment variable
 * LOG_LEVEL to control verbosity.
 *
 * Levels: error(0) < warn(1) < info(2) < debug(3) < trace(4)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = exports.LogLevel = void 0;
exports.createLogger = createLogger;
var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["ERROR"] = 0] = "ERROR";
    LogLevel[LogLevel["WARN"] = 1] = "WARN";
    LogLevel[LogLevel["INFO"] = 2] = "INFO";
    LogLevel[LogLevel["DEBUG"] = 3] = "DEBUG";
    LogLevel[LogLevel["TRACE"] = 4] = "TRACE";
})(LogLevel || (exports.LogLevel = LogLevel = {}));
const LOG_LEVEL_NAMES = {
    [LogLevel.ERROR]: 'ERROR',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.TRACE]: 'TRACE',
};
/**
 * Get current log level from environment
 */
function getCurrentLogLevel() {
    var _a;
    const level = (_a = process.env.LOG_LEVEL) === null || _a === void 0 ? void 0 : _a.toUpperCase();
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
function formatMessage(level, namespace, message) {
    const timestamp = new Date().toISOString();
    const levelName = LOG_LEVEL_NAMES[level];
    return `[${timestamp}] [${levelName}] [${namespace}] ${message}`;
}
/**
 * Create a namespaced logger
 * @param namespace Logger namespace (e.g., 'NeuronRegistry', 'GraphCompiler')
 * @returns Logger object with level-specific methods
 */
function createLogger(namespace) {
    const currentLevel = getCurrentLogLevel();
    return {
        /**
         * Log an error message (always logged)
         */
        error(message, ...args) {
            if (currentLevel >= LogLevel.ERROR) {
                console.error(formatMessage(LogLevel.ERROR, namespace, message), ...args);
            }
        },
        /**
         * Log a warning message
         */
        warn(message, ...args) {
            if (currentLevel >= LogLevel.WARN) {
                console.warn(formatMessage(LogLevel.WARN, namespace, message), ...args);
            }
        },
        /**
         * Log an info message (default level)
         */
        info(message, ...args) {
            if (currentLevel >= LogLevel.INFO) {
                console.log(formatMessage(LogLevel.INFO, namespace, message), ...args);
            }
        },
        /**
         * Log a debug message (development only by default)
         */
        debug(message, ...args) {
            if (currentLevel >= LogLevel.DEBUG) {
                console.log(formatMessage(LogLevel.DEBUG, namespace, message), ...args);
            }
        },
        /**
         * Log a trace message (very verbose, must be explicitly enabled)
         */
        trace(message, ...args) {
            if (currentLevel >= LogLevel.TRACE) {
                console.log(formatMessage(LogLevel.TRACE, namespace, message), ...args);
            }
        },
        /**
         * Check if a log level is enabled
         */
        isEnabled(level) {
            return currentLevel >= level;
        },
    };
}
/**
 * Default logger for quick usage
 */
exports.log = createLogger('AI');
