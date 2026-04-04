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
/**
 * Execute a loop step - runs nested steps repeatedly until exit condition met
 *
 * @param config - Loop configuration with maxIterations, exitCondition, steps, etc.
 * @param state - Current state (includes data from previous steps)
 * @returns Partial state update with loop results
 */
export declare function executeLoop(config: LoopStepConfig, state: any): Promise<Partial<any>>;
