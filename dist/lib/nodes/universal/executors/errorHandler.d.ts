/**
 * Error Handler Utility
 *
 * Provides retry logic, fallback strategies, and error propagation control
 * for universal node step execution.
 */
import type { ErrorHandlingConfig } from '../types';
/**
 * Execute an async operation with error handling (retry, fallback, skip)
 *
 * @param operation - Async function to execute
 * @param config - Error handling configuration
 * @param stepInfo - Information about the step for logging (type, number, etc.)
 * @returns Operation result or fallback value
 * @throws Error if onError='throw' or all retries exhausted
 */
export declare function executeWithErrorHandling<T>(operation: () => Promise<T>, config?: ErrorHandlingConfig, stepInfo?: {
    type: string;
    number?: number;
    field?: string;
}): Promise<T>;
/**
 * Create error context for better error messages
 *
 * @param error - Original error
 * @param context - Additional context (step type, iteration, etc.)
 * @returns Enhanced error with context
 */
export declare function enhanceError(error: Error | unknown, context: {
    stepType?: string;
    stepNumber?: number;
    iteration?: number;
    outputField?: string;
}): Error;
