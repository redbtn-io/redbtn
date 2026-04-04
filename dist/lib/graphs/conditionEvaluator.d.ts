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
