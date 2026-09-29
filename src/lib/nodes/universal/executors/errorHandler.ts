/**
 * Error Handler Utility
 *
 * Provides retry logic, fallback strategies, and error propagation control
 * for universal node step execution.
 */
import type { ErrorHandlingConfig } from '../types';
import { redactSensitive } from '../../../utils/redact-sensitive';

// Debug logging - set to true to enable verbose logs
const DEBUG = false;

/**
 * A failure `onError` recovered from: every attempt failed and the step went
 * on with its `fallbackValue` ('fallback') or with nothing ('skip').
 */
export interface RecoveredStepFailure {
    /** The error from the final attempt. */
    error: Error;
    /** How many times the operation ran: the initial attempt plus retries. */
    attempts: number;
    strategy: 'fallback' | 'skip';
}

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
    return (await executeWithErrorHandlingDetailed(operation, config, stepInfo)).value;
}

/**
 * `executeWithErrorHandling`, also saying whether the value came from a
 * recovered failure. `recovered` is null when an attempt succeeded. The
 * 'throw' path is the same: the final attempt's error is rethrown unchanged.
 */
export async function executeWithErrorHandlingDetailed<T>(
    operation: () => Promise<T>,
    config?: ErrorHandlingConfig,
    stepInfo?: {
        type: string;
        number?: number;
        field?: string;
    }
): Promise<{ value: T; recovered: RecoveredStepFailure | null }> {
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
            return { value: result, recovered: null };
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

    // Only a negative `retry` (the loop never ran) leaves lastError unset.
    const finalError = lastError ?? new Error(`${stepInfo?.type || 'Step'} did not run (errorHandling.retry < 0)`);

    switch (onError) {
        case 'fallback':
            if (DEBUG)
                console.log(`[ErrorHandler] Using fallback value for ${stepInfo?.field || 'output'}:`, JSON.stringify(fallbackValue).substring(0, 100));
            return { value: fallbackValue, recovered: { error: finalError, attempts: attempt, strategy: 'fallback' } };
        case 'skip':
            if (DEBUG)
                console.log(`[ErrorHandler] Skipping ${stepInfo?.type || 'step'}`);
            return { value: undefined as unknown as T, recovered: { error: finalError, attempts: attempt, strategy: 'skip' } };
        case 'throw':
        default:
            if (onError !== 'throw') {
                // An unrecognized onError (e.g. 'continue') silently degrades to
                // 'throw', turning any configured fallbackValue into dead config
                // — exactly how the Become cli-analyst swallowed its ssh_shell
                // failures. Config validation rejects new offenders; this warn
                // surfaces existing bad documents.
                console.warn(
                    `[ErrorHandler] Invalid onError value "${String(onError)}" — ` +
                    `valid: throw | fallback | skip. Treating as 'throw'.`
                );
            }
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

// =============================================================================
// Step error records: state.data._stepErrors[<outputField>]
// =============================================================================

/** Longest `message` a step error record keeps. */
export const STEP_ERROR_MESSAGE_MAX = 2000;

/**
 * What `state.data._stepErrors[<outputField>]` holds after a neuron or tool
 * step fell back ('fallback') or was skipped ('skip').
 *
 * Before this the error only reached the worker's stdout: a step with
 * `fallbackValue: ''` handed later steps an empty string and no way to say
 * why. The bag is keyed by the step's `outputField` string exactly like
 * `data._cli` and `data._fallback`, so a transform reads
 * `state.data._stepErrors['data.response'].message`.
 *
 * The entry describes the value currently at `outputField`: the next neuron or
 * tool step that writes that field successfully clears it (to `undefined`).
 * `onError: 'throw'` never writes one.
 */
export interface StepErrorRecord {
    /** The final attempt's message, secret-redacted, at most STEP_ERROR_MESSAGE_MAX chars. */
    message: string;
    /** Machine-readable code for the failure, or null. See `classifyStepErrorCode`. */
    code: string | null;
    stepType: 'neuron' | 'tool';
    /** Neuron steps: the neuron the step was configured to run (null if it never resolved). */
    neuronId?: string | null;
    /** Tool steps: the tool that was called. */
    toolName?: string;
    /** Attempts made: the initial one plus `errorHandling.retry`. */
    attempts: number;
    /** When the step gave up, ISO 8601. */
    at: string;
}

/** Which step a record is about. */
export type StepErrorSubject =
    | { stepType: 'neuron'; neuronId: string | null }
    | { stepType: 'tool'; toolName: string };

/** Built-in error classes. Naming one says nothing about what failed. */
const GENERIC_ERROR_NAMES: ReadonlySet<string> = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'EvalError',
    'URIError',
    'AggregateError',
]);

/**
 * The code recorded for a step failure.
 *
 * Executors wrap what they caught (`Neuron step failed: ...`) and keep the
 * original on `cause`, so this walks that chain (bounded) and returns:
 *   1. the first string `code` on it: `claude_code_timeout`, `agy_timeout`,
 *      `opencode_spawn_failed`, `TOOL_IDLE_TIMEOUT`, `ECONNRESET`, ...
 *      (Numeric codes, such as DOMException's legacy ones, are skipped.)
 *   2. failing that, the first error class name that is not a built-in one.
 *      That is how a `WorkspaceSpawnError`, whose class carries no code, still
 *      comes out as `'WorkspaceSpawnError'` instead of null.
 *   3. otherwise null.
 */
export function classifyStepErrorCode(error: unknown): string | null {
    const chain: Array<Record<string, unknown>> = [];
    let current: unknown = error;
    for (let i = 0; i < 5 && current && typeof current === 'object'; i++) {
        chain.push(current as Record<string, unknown>);
        current = (current as { cause?: unknown }).cause;
    }
    for (const link of chain) {
        const code = link.code;
        if (typeof code === 'string' && code) return code;
    }
    for (const link of chain) {
        const name = link.name;
        if (typeof name === 'string' && name && !GENERIC_ERROR_NAMES.has(name)) return name;
    }
    return null;
}

function stepErrorMessage(error: Error): string {
    const raw = typeof error?.message === 'string' && error.message ? error.message : String(error);
    // Redact before capping: a credential cut in half by the cap could slip
    // past a pattern that needs the whole token to match.
    const redacted = redactSensitive(raw);
    return redacted.length > STEP_ERROR_MESSAGE_MAX
        ? `${redacted.slice(0, STEP_ERROR_MESSAGE_MAX - 1)}…`
        : redacted;
}

/** Build the record for a recovered failure. */
export function buildStepErrorRecord(
    failure: RecoveredStepFailure,
    subject: StepErrorSubject,
    now: Date = new Date(),
): StepErrorRecord {
    return {
        message: stepErrorMessage(failure.error),
        code: classifyStepErrorCode(failure.error),
        stepType: subject.stepType,
        // Both identity keys are always present, the other one undefined. The
        // `data` reducer deep-merges records, so a neuron record landing on a
        // tool record for the same outputField would otherwise keep its toolName.
        neuronId: subject.stepType === 'neuron' ? subject.neuronId : undefined,
        toolName: subject.stepType === 'tool' ? subject.toolName : undefined,
        attempts: failure.attempts,
        at: now.toISOString(),
    };
}

function currentStepErrors(state: any): Record<string, StepErrorRecord | undefined> {
    const bag = state?.data?._stepErrors;
    return bag && typeof bag === 'object' && !Array.isArray(bag) ? bag : {};
}

/**
 * `partial` (the step's update) plus a record of `failure` under
 * `state.data._stepErrors[outputField]`.
 *
 * Written the way `data._cli` and `data._fallback` are: the WHOLE bag goes
 * back under the one flat key `'data._stepErrors'`. universalNode's
 * convertFlatToNested splits only that key, so a dotted outputField such as
 * `'data.response'` stays a single key inside the bag. The live state is
 * updated too, so a later step of the same node sees the record.
 *
 * `partial` is spread as-is, so it reaches the node's update exactly as it
 * did before this record existed.
 */
export function recordStepError(
    state: any,
    outputField: string,
    failure: RecoveredStepFailure,
    subject: StepErrorSubject,
    partial: any,
): any {
    if (typeof outputField !== 'string' || !outputField) return partial;
    const merged = { ...currentStepErrors(state), [outputField]: buildStepErrorRecord(failure, subject) };
    if (state && typeof state === 'object') {
        state.data = state.data || {};
        state.data._stepErrors = merged;
    }
    return { ...partial, 'data._stepErrors': merged };
}

/**
 * `partial` with any record for `outputField` cleared, after the step writing
 * that field succeeded. Returns `partial` itself when there is nothing to
 * clear, so a run that never recorded an error sees no change at all.
 *
 * The entry is set to `undefined` rather than left out: the `data` reducer
 * deep-merges, so a bag that merely lacked the key would keep the old record.
 */
export function clearStepError(state: any, outputField: string, partial: any): any {
    if (typeof outputField !== 'string' || !outputField) return partial;
    const existing = currentStepErrors(state);
    if (existing[outputField] === undefined) return partial;
    const merged = { ...existing, [outputField]: undefined };
    state.data._stepErrors = merged;
    return { ...partial, 'data._stepErrors': merged };
}
