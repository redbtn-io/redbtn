/**
 * Step Executor Dispatcher
 *
 * Routes each step to the appropriate executor based on step type.
 * This is the central dispatch point for all universal node step execution.
 */
import type { UniversalStep } from './types';
/**
 * Execute a single step based on its type
 *
 * @param step - Step configuration with type and config
 * @param state - Current state (includes original state + accumulated updates from previous steps)
 * @returns Partial state update from this step
 * @throws Error if step type is unknown or execution fails
 */
export declare function executeStep(step: UniversalStep, state: any): Promise<Partial<any>>;
