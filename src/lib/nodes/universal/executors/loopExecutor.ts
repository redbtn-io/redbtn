/**
 * Loop Step Executor
 *
 * Executes a sequence of steps repeatedly until an exit condition is met or max iterations reached.
 * Supports accumulation of results across iterations.
 *
 * Use cases:
 * - Iterative web search (search → evaluate → refine → repeat)
 * - Retry logic with progressive refinement
 * - Batch processing with result accumulation
 */
import type { LoopStepConfig } from '../types';
import { executeStep } from '../stepExecutor';

// Debug logging - set to true to enable verbose logs
const DEBUG = false;

/**
 * Convert flat dot-notation object to nested object
 * Example: { 'data.executionPlan': {...}, 'data.hasPlan': true }
 *       → { data: { executionPlan: {...}, hasPlan: true } }
 */
function convertFlatToNested(flat: Record<string, any>): Record<string, any> {
    const nested: Record<string, any> = {};
    for (const [key, value] of Object.entries(flat)) {
        if (!key.includes('.')) {
            // Top-level field, set directly
            nested[key] = value;
        }
        else {
            // Nested field with dot notation
            const parts = key.split('.');
            let current: Record<string, any> = nested;
            // Navigate/create nested structure
            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i];
                if (!(part in current)) {
                    current[part] = {};
                }
                current = current[part];
            }
            // Set the final value
            const lastPart = parts[parts.length - 1];
            current[lastPart] = value;
        }
    }
    return nested;
}

/**
 * Deep merge source into target (mutates target)
 */
function deepMergeInPlace(target: Record<string, any>, source: Record<string, any>): void {
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            // Recursively merge nested objects
            if (!target[key]) {
                target[key] = {};
            }
            deepMergeInPlace(target[key], source[key]);
        }
        else {
            // Directly assign primitives, arrays, and null values
            target[key] = source[key];
        }
    }
}

/**
 * Resolve a config value that might be a template string like "{{parameters.maxIterations}}"
 * Returns the resolved value or the original value
 */
function resolveConfigValue(value: any, state: any): any {
    if (typeof value !== 'string') {
        return value;
    }
    // Check if it's a simple parameter template like "{{parameters.maxIterations}}"
    const paramMatch = value.match(/^\{\{parameters\.(\w+)\}\}$/);
    if (paramMatch && state.parameters) {
        const paramName = paramMatch[1];
        const resolved = state.parameters[paramName];
        if (resolved !== undefined) {
            if (DEBUG)
                console.log(`[LoopExecutor] Resolved parameter ${paramName}:`, resolved);
            return resolved;
        }
    }
    // Not a template or couldn't resolve - return as-is
    return value;
}

/**
 * Execute a loop step - runs nested steps repeatedly until exit condition met
 *
 * @param config - Loop configuration with maxIterations, exitCondition, steps, etc.
 * @param state - Current state (includes data from previous steps)
 * @returns Partial state update with loop results
 */
export async function executeLoop(config: LoopStepConfig, state: any): Promise<Partial<any>> {
    console.log('[LoopExecutor] ====== STARTING LOOP ======');
    console.log('[LoopExecutor] MaxIterations:', config.maxIterations);
    console.log('[LoopExecutor] ExitCondition:', config.exitCondition);
    console.log('[LoopExecutor] Steps count:', config.steps?.length);
    console.log('[LoopExecutor] OnMaxIterations:', config.onMaxIterations);
    const { exitCondition, accumulatorField, steps, onMaxIterations = 'continue' } = config;
    // Resolve maxIterations - might be a template like "{{parameters.maxIterations}}"
    const resolvedMaxIterations = resolveConfigValue(config.maxIterations, state);
    const maxIterations = typeof resolvedMaxIterations === 'number' ? resolvedMaxIterations : 5;
    if (DEBUG) {
        console.log(`[LoopExecutor] Starting loop (max: ${maxIterations}, steps: ${steps?.length || 0})`);
    }
    // Validate loop has steps
    if (!steps || steps.length === 0) {
        throw new Error('[LoopExecutor] Loop must have at least one step');
    }
    // Initialize accumulator array if field specified
    const accumulatorArray: any[] = [];
    // Track iteration count (1-indexed for user-friendly exit conditions)
    let iteration = 0;
    let exitConditionMet = false;
    // Clone current state to avoid mutating during loop
    const loopState: Record<string, any> = { ...state };
    while (iteration < maxIterations && !exitConditionMet) {
        iteration++;
        console.log(`[LoopExecutor] ====== ITERATION ${iteration}/${maxIterations} ======`);
        // Execute all steps in this iteration
        for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
            const step = steps[stepIndex];
            const stepNumber = stepIndex + 1;
            try {
                // Create iteration state with current loop data and metadata
                // Inject loop metadata into data object
                const iterationState = {
                    ...loopState,
                    data: {
                        ...(loopState.data || {}),
                        loopIteration: iteration,
                        loopAccumulator: accumulatorArray
                    }
                };
                // Execute step
                const stepUpdate = await executeStep(step, iterationState);
                // Convert flat dot-notation keys to nested and deep merge
                const nestedUpdate = convertFlatToNested(stepUpdate);
                deepMergeInPlace(loopState, nestedUpdate);
                if (DEBUG) {
                    console.log(`[LoopExecutor] Iteration ${iteration}, Step ${stepNumber} completed.`, `Updated:`, Object.keys(stepUpdate).join(', '));
                }
            }
            catch (error: any) {
                console.error(`[LoopExecutor] Iteration ${iteration}, Step ${stepNumber} (${step.type}) failed:`, error.message);
                throw new Error(`Loop iteration ${iteration}, step ${stepNumber} (${step.type}) failed: ${error.message}`);
            }
        }
        // Accumulate iteration result if field specified
        if (accumulatorField && loopState[accumulatorField] !== undefined) {
            accumulatorArray.push(loopState[accumulatorField]);
        }
        // Evaluate exit condition
        try {
            exitConditionMet = evaluateExitCondition(exitCondition, {
                ...loopState,
                data: {
                    ...(loopState.data || {}),
                    loopIteration: iteration,
                    loopAccumulator: accumulatorArray
                }
            });
            if (exitConditionMet) {
                if (DEBUG)
                    console.log(`[LoopExecutor] Exit condition met after ${iteration} iteration(s)`);
            }
        }
        catch (error: any) {
            console.warn(`[LoopExecutor] Error evaluating exit condition: ${error.message}`, `Condition: ${exitCondition}`);
            // Continue loop on evaluation error (safer than crashing)
        }
    }
    // Handle max iterations reached
    if (iteration === maxIterations && !exitConditionMet) {
        console.warn(`[LoopExecutor] Max iterations (${maxIterations}) reached without meeting exit condition`);
        if (onMaxIterations === 'throw') {
            throw new Error(`Loop exceeded max iterations (${maxIterations}) without meeting exit condition: ${exitCondition}`);
        }
        // onMaxIterations === 'continue' - proceed with current state
    }
    if (DEBUG) {
        console.log(`[LoopExecutor] Loop complete. Iterations: ${iteration}, Exit condition met: ${exitConditionMet}`);
    }
    // Build result object - ONLY include data fields that changed during loop
    // Do NOT spread entire loopState (contains infrastructure like mcpClient, logger, etc.)
    const infrastructureKeys = ['mcpClient', 'logger', 'neuronRegistry', 'memory',
        // 'messageQueue' removed in v0.0.51-alpha — no longer in graph state
        'userId', 'accountTier', 'options', 'query', 'data']; // IMPORTANT: Don't return 'data' directly - it overwrites parent state!
    const result: Record<string, any> = {
        loopIterations: iteration,
        loopExitConditionMet: exitConditionMet
    };
    // Copy only data fields (not infrastructure) from loop state
    // IMPORTANT: Only include fields with defined values to avoid overwriting graph state with undefined
    for (const key in loopState) {
        if (!infrastructureKeys.includes(key) && !key.startsWith('_')) {
            const value = loopState[key];
            // Skip undefined values - let LangGraph preserve existing state values
            if (value !== undefined) {
                result[key] = value;
            }
        }
    }
    // Handle data field separately - return as dot-notation updates to preserve parent state
    if (loopState.data && typeof loopState.data === 'object') {
        for (const dataKey in loopState.data) {
            if (loopState.data[dataKey] !== undefined) {
                result[`data.${dataKey}`] = loopState.data[dataKey];
            }
        }
    }
    if (DEBUG)
        console.log('[LoopExecutor] Returning fields:', Object.keys(result).join(', '));
    // Add accumulator array if used
    if (accumulatorField) {
        const accumulatorArrayField = `${accumulatorField}Array`;
        result[accumulatorArrayField] = accumulatorArray;
        result[`${accumulatorField}Count`] = accumulatorArray.length;
    }
    return result;
}

/**
 * Evaluate exit condition expression
 *
 * Supports:
 * - Comparisons: ===, !==, >, <, >=, <=
 * - Logical: &&, ||
 * - State access: state.field, state.loopIteration, state.loopAccumulator
 *
 * @param condition - Exit condition expression string
 * @param state - Current state with loop metadata
 * @returns True if loop should exit, false if should continue
 */
function evaluateExitCondition(condition: string, state: any): boolean {
    try {
        // Create safe evaluation context with only state access
        const context = {
            state: state
        };
        // Build evaluation function with restricted scope
        const evalFunc = new Function('context', `
      with (context) {
        return ${condition};
      }
    `);
        const result = evalFunc(context);
        // Ensure boolean result
        return Boolean(result);
    }
    catch (error: any) {
        console.error(`[LoopExecutor] Failed to evaluate exit condition: ${condition}`, error.message);
        // On error, don't exit loop (safer default)
        return false;
    }
}
