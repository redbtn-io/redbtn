/**
 * Network-aware retry helpers for LLM calls.
 */

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

type RetryOptions = {
  maxAttempts?: number;
  delayMs?: number;
  context?: string;
  onRetry?: (attempt: number, error: unknown) => void;
};

export function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as { code?: string; message?: string; name?: string };

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

export async function wait(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function runWithNetworkRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelay = options.delayMs ?? 250;

  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isNetworkError(error) || attempt >= maxAttempts) {
        throw error;
      }

      if (options.onRetry) {
        options.onRetry(attempt, error);
      } else if (options.context) {
        console.warn(`[Retry] Network error during ${options.context} (attempt ${attempt}/${maxAttempts}), retrying...`, error);
      }

      const backoff = baseDelay * attempt;
      await wait(backoff);
    }
  }

  throw lastError;
}

export async function invokeWithRetry<TInput, TResult>(
  model: { invoke: (input: TInput) => Promise<TResult> },
  input: TInput,
  options: RetryOptions = {}
): Promise<TResult> {
  return runWithNetworkRetry(() => model.invoke(input), {
    ...options,
    context: options.context || 'LLM invoke',
  });
}
