/**
 * Network-aware retry helpers for LLM calls.
 */
type RetryOptions = {
    maxAttempts?: number;
    delayMs?: number;
    context?: string;
    onRetry?: (attempt: number, error: unknown) => void;
};
export declare function isNetworkError(error: unknown): boolean;
export declare function wait(ms: number): Promise<void>;
export declare function runWithNetworkRetry<T>(operation: () => Promise<T>, options?: RetryOptions): Promise<T>;
export declare function invokeWithRetry<TInput, TResult>(model: {
    invoke: (input: TInput) => Promise<TResult>;
}, input: TInput, options?: RetryOptions): Promise<TResult>;
export {};
