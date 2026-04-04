"use strict";
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
exports.executeWithErrorHandling = executeWithErrorHandling;
exports.enhanceError = enhanceError;
// Debug logging - set to true to enable verbose logs
const DEBUG = false;
/**
 * Execute an async operation with error handling (retry, fallback, skip)
 *
 * @param operation - Async function to execute
 * @param config - Error handling configuration
 * @param stepInfo - Information about the step for logging (type, number, etc.)
 * @returns Operation result or fallback value
 * @throws Error if onError='throw' or all retries exhausted
 */
function executeWithErrorHandling(operation, config, stepInfo) {
    return __awaiter(this, void 0, void 0, function* () {
        const { retry = 0, retryDelay = 1000, fallbackValue, onError = 'throw' } = config || {};
        let lastError = null;
        let attempt = 0;
        if (DEBUG)
            console.log(`[ErrorHandler] Executing ${(stepInfo === null || stepInfo === void 0 ? void 0 : stepInfo.type) || 'step'} (max retries: ${retry})`);
        // Try initial execution + retries
        while (attempt <= retry) {
            try {
                const result = yield operation();
                if (attempt > 0 && DEBUG) {
                    console.log(`[ErrorHandler] ${(stepInfo === null || stepInfo === void 0 ? void 0 : stepInfo.type) || 'Step'} succeeded on retry ${attempt}/${retry}`);
                }
                return result;
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                attempt++;
                console.warn(`[ErrorHandler] ${(stepInfo === null || stepInfo === void 0 ? void 0 : stepInfo.type) || 'Step'} failed (attempt ${attempt}/${retry + 1}):`, lastError.message);
                // If we have retries left, wait and try again
                if (attempt <= retry) {
                    if (DEBUG)
                        console.log(`[ErrorHandler] Retrying in ${retryDelay}ms...`);
                    yield new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }
                // No more retries - break to handle error strategy
                break;
            }
        }
        // All retries exhausted - apply error strategy
        console.error(`[ErrorHandler] ${(stepInfo === null || stepInfo === void 0 ? void 0 : stepInfo.type) || 'Step'} failed after ${attempt} attempts. Strategy: ${onError}`);
        switch (onError) {
            case 'fallback':
                if (DEBUG)
                    console.log(`[ErrorHandler] Using fallback value for ${(stepInfo === null || stepInfo === void 0 ? void 0 : stepInfo.field) || 'output'}:`, JSON.stringify(fallbackValue).substring(0, 100));
                return fallbackValue;
            case 'skip':
                if (DEBUG)
                    console.log(`[ErrorHandler] Skipping ${(stepInfo === null || stepInfo === void 0 ? void 0 : stepInfo.type) || 'step'}`);
                return undefined;
            case 'throw':
            default:
                console.error(`[ErrorHandler] Throwing error: ${lastError === null || lastError === void 0 ? void 0 : lastError.message}`);
                throw lastError;
        }
    });
}
/**
 * Create error context for better error messages
 *
 * @param error - Original error
 * @param context - Additional context (step type, iteration, etc.)
 * @returns Enhanced error with context
 */
function enhanceError(error, context) {
    const baseError = error instanceof Error ? error : new Error(String(error));
    const contextParts = [];
    if (context.stepType)
        contextParts.push(`step type: ${context.stepType}`);
    if (context.stepNumber)
        contextParts.push(`step #${context.stepNumber}`);
    if (context.iteration)
        contextParts.push(`iteration ${context.iteration}`);
    if (context.outputField)
        contextParts.push(`output field: ${context.outputField}`);
    const contextStr = contextParts.length > 0 ? ` (${contextParts.join(', ')})` : '';
    const enhancedError = new Error(`${baseError.message}${contextStr}`);
    enhancedError.stack = baseError.stack;
    return enhancedError;
}
