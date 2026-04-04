"use strict";
/**
 * Network-aware retry helpers for LLM calls.
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
exports.isNetworkError = isNetworkError;
exports.wait = wait;
exports.runWithNetworkRetry = runWithNetworkRetry;
exports.invokeWithRetry = invokeWithRetry;
const NETWORK_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'EAI_AGAIN',
]);
const NETWORK_ERROR_MESSAGE_FRAGMENTS = [
    'fetch failed',
    'socket hang up',
    'connection reset',
    'connection refused',
    'network error',
    'timeout',
    'timed out',
    'server disconnected',
    'unable to connect',
    'getaddrinfo',
];
function isNetworkError(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const err = error;
    if (err.code && NETWORK_ERROR_CODES.has(err.code)) {
        return true;
    }
    const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
    if (message && NETWORK_ERROR_MESSAGE_FRAGMENTS.some(fragment => message.includes(fragment))) {
        return true;
    }
    const name = typeof err.name === 'string' ? err.name.toLowerCase() : '';
    if (name.includes('apiconnection') || name.includes('timeout')) {
        return true;
    }
    return false;
}
function wait(ms) {
    return __awaiter(this, void 0, void 0, function* () {
        if (ms <= 0) {
            return;
        }
        yield new Promise(resolve => setTimeout(resolve, ms));
    });
}
function runWithNetworkRetry(operation_1) {
    return __awaiter(this, arguments, void 0, function* (operation, options = {}) {
        var _a, _b;
        const maxAttempts = Math.max(1, (_a = options.maxAttempts) !== null && _a !== void 0 ? _a : 3);
        const baseDelay = (_b = options.delayMs) !== null && _b !== void 0 ? _b : 250;
        let attempt = 0;
        let lastError;
        while (attempt < maxAttempts) {
            attempt += 1;
            try {
                return yield operation();
            }
            catch (error) {
                lastError = error;
                if (!isNetworkError(error) || attempt >= maxAttempts) {
                    throw error;
                }
                if (options.onRetry) {
                    options.onRetry(attempt, error);
                }
                else if (options.context) {
                    console.warn(`[Retry] Network error during ${options.context} (attempt ${attempt}/${maxAttempts}), retrying...`, error);
                }
                const backoff = baseDelay * attempt;
                yield wait(backoff);
            }
        }
        throw lastError;
    });
}
function invokeWithRetry(model_1, input_1) {
    return __awaiter(this, arguments, void 0, function* (model, input, options = {}) {
        return runWithNetworkRetry(() => model.invoke(input), Object.assign(Object.assign({}, options), { context: options.context || 'LLM invoke' }));
    });
}
