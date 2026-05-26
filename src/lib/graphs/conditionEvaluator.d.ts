/**
 * Condition Evaluator
 *
 * Phase 1: Dynamic Graph System
 * Safely evaluates conditional edge expressions without using eval().
 * Uses an allowlist-based approach for security.
 */
/**
 * Type for condition functions used in conditional edges
 * Must return a string representing the next node ID
 */
export type ConditionFunction = (state: any) => string;
/**
 * Creates a condition function from a string expression.
 *
 * Supports common patterns:
 * - "state.field === 'value'"
 * - "state.field !== 'value'"
 * - "state.field > 10"
 * - "state.field && state.field.length > 0"
 * - "state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length"
 *
 * @param expression Condition string (JavaScript-like syntax)
 * @param targets Map of condition results to target node IDs
 * @param fallback Default node ID if condition false
 * @returns Function that evaluates condition and returns next node ID
 */
export declare function createConditionFunction(expression: string, targets?: Record<string, string>, fallback?: string): ConditionFunction;
/**
 * Error thrown by the condition evaluator on unsupported expressions or
 * runtime evaluation failures. Carries the offending expression for diagnostics.
 *
 * - Thrown at graph-compile time when `createConditionFunction` is called with
 *   an expression that does not match any allowlisted shape.
 * - Thrown at run time from inside the returned closure when an allowlisted
 *   expression somehow fails during evaluation.
 */
export declare class ConditionEvaluatorError extends Error {
    readonly expression: string;
    constructor(message: string, expression: string);
}
