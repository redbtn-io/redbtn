/**
 * Error Handler Utility
 *
 * Provides retry logic, fallback strategies, and error propagation control
 * for universal node step execution.
 */
import type { ErrorHandlingConfig } from '../types';

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
export async function executeWithErrorHandling<T>(
    operation: () => Promise<T>,
    config?: ErrorHandlingConfig,
    stepInfo?: {
        type: string;
        number?: number;
        field?: string;
    }
): Promise<T> {
    const { retry = 0, retryDelay = 1000, fallbackValue, onError = 'throw' } = config || {};
    let lastError: Error | null = null;
    let attempt = 0;

    if (DEBUG)
        console.log(`[ErrorHandler] Executing ${stepInfo?.type || 'step'} (max retries: ${retry})`);

    // Try initial execution + retries
    while (attempt <= retry) {
        try {
            const result = await operation();
            if (attempt > 0 && DEBUG) {
                console.log(`[ErrorHandler] ${stepInfo?.type || 'Step'} succeeded on retry ${attempt}/${retry}`);
            }
            return result;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            attempt++;
            console.warn(`[ErrorHandler] ${stepInfo?.type || 'Step'} failed (attempt ${attempt}/${retry + 1}):`, lastError.message);

            // If we have retries left, wait and try again
            if (attempt <= retry) {
                if (DEBUG)
                    console.log(`[ErrorHandler] Retrying in ${retryDelay}ms...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                continue;
            }

            // No more retries - break to handle error strategy
            break;
        }
    }

    // All retries exhausted - apply error strategy
    console.error(`[ErrorHandler] ${stepInfo?.type || 'Step'} failed after ${attempt} attempts. Strategy: ${onError}`);

    switch (onError) {
        case 'fallback':
            if (DEBUG)
                console.log(`[ErrorHandler] Using fallback value for ${stepInfo?.field || 'output'}:`, JSON.stringify(fallbackValue).substring(0, 100));
            return fallbackValue;
        case 'skip':
            if (DEBUG)
                console.log(`[ErrorHandler] Skipping ${stepInfo?.type || 'step'}`);
            return undefined as unknown as T;
        case 'throw':
        default:
            console.error(`[ErrorHandler] Throwing error: ${lastError?.message}`);
            throw lastError;
    }
}

/**
 * Create error context for better error messages
 *
 * @param error - Original error
 * @param context - Additional context (step type, iteration, etc.)
 * @returns Enhanced error with context
 */
export function enhanceError(
    error: Error | unknown,
    context: {
        stepType?: string;
        stepNumber?: number;
        iteration?: number;
        outputField?: string;
    }
): Error {
    const baseError = error instanceof Error ? error : new Error(String(error));
    const contextParts: string[] = [];

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
