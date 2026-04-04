import type { TransformStepConfig } from '../types';
/**
 * Execute a transform step
 *
 * Operations:
 * - map: Apply transform template to each array element
 * - filter: Keep array elements where filterCondition evaluates to true
 * - select: Extract nested property from input using dot notation
 * - set-global: Set a value in persistent global state
 * - get-global: Get a value from persistent global state
 *
 * @param config - Transform step configuration
 * @param state - Current graph state (includes accumulated updates from previous steps)
 * @returns Partial state with output field set to transformed data
 */
export declare function executeTransform(config: TransformStepConfig, state: any): Promise<Partial<any>>;
