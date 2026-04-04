/**
 * Conditional Step Executor
 *
 * Evaluates boolean conditions and sets state fields based on result.
 * Used for routing logic, validation checks, and conditional field setting.
 */
import type { ConditionalStepConfig } from '../types';
/**
 * Execute a conditional step
 *
 * Flow:
 * 1. Render condition template with current state
 * 2. Evaluate condition to boolean
 * 3. Set output field to trueValue or falseValue based on result
 *
 * Example:
 * condition: "{{state.searchResults.length}} > 0"
 * setField: "hasResults"
 * trueValue: true
 * falseValue: false
 *
 * Result: { hasResults: true } if searchResults has items
 *
 * @param config - Conditional step configuration
 * @param state - Current graph state (includes accumulated updates from previous steps)
 * @returns Partial state with setField set to trueValue or falseValue
 */
export declare function executeConditional(config: ConditionalStepConfig, state: any): Partial<any>;
