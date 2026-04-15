/**
 * Step Executor Dispatcher
 *
 * Routes each step to the appropriate executor based on step type.
 * This is the central dispatch point for all universal node step execution.
 */

import type { UniversalStep } from './types';
import type { NeuronStepConfig } from './types';
import type { ToolStepConfig } from './types';
import type { TransformStepConfig } from './types';
import type { ConditionalStepConfig } from './types';
import type { LoopStepConfig } from './types';
import type { ConnectionStepConfig } from './types';
import type { GraphStepConfig } from './types';
import { resolveValue } from './templateRenderer';

// These imports resolve from the dist/ directory at runtime — they are
// hand-maintained modules that have no source counterpart in src/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeNeuron } = require('./executors/neuronExecutor') as { executeNeuron: (config: NeuronStepConfig, state: any) => Promise<Partial<any>> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeTool } = require('./executors/toolExecutor') as { executeTool: (config: ToolStepConfig, state: any) => Promise<Partial<any>> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeTransform } = require('./executors/transformExecutor') as { executeTransform: (config: TransformStepConfig, state: any) => Promise<Partial<any>> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeConditional } = require('./executors/conditionalExecutor') as { executeConditional: (config: ConditionalStepConfig, state: any) => Partial<any> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeLoop } = require('./executors/loopExecutor') as { executeLoop: (config: LoopStepConfig, state: any) => Promise<Partial<any>> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeConnection } = require('./executors/connectionExecutor') as { executeConnection: (config: ConnectionStepConfig, state: any) => Promise<Partial<any>> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeGraph } = require('./executors/graphExecutor') as { executeGraph: (config: GraphStepConfig, state: any) => Promise<Partial<any>> };

/**
 * Execute a single step based on its type
 *
 * @param step - Step configuration with type and config
 * @param state - Current state (includes original state + accumulated updates from previous steps)
 * @returns Partial state update from this step
 * @throws Error if step type is unknown or execution fails
 */
export async function executeStep(step: UniversalStep, state: any): Promise<Partial<any>> {
    console.log(`[StepExecutor] ====== EXECUTING STEP: ${step.type} ======`);
    console.log(`[StepExecutor] Step config keys:`, Object.keys(step.config || {}));
    // Check optional condition
    if (step.condition) {
        console.log(`[StepExecutor] Checking condition: ${step.condition}`);
        const shouldRun = evaluateStepCondition(step.condition, state);
        if (!shouldRun) {
            console.log(`[StepExecutor] Skipping step due to condition: ${step.condition}`);
            return {}; // Skip execution, return empty update
        }
        console.log(`[StepExecutor] Condition passed, executing step`);
    }
    console.log(`[StepExecutor] Dispatching to ${step.type} executor...`);
    const startTime = Date.now();
    switch (step.type) {
        case 'neuron': {
            console.log(`[StepExecutor] Calling executeNeuron...`);
            const result = await executeNeuron(step.config as NeuronStepConfig, state);
            console.log(`[StepExecutor] executeNeuron completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
            return result;
        }
        case 'tool': {
            console.log(`[StepExecutor] Calling executeTool...`);
            const result = await executeTool(step.config as ToolStepConfig, state);
            console.log(`[StepExecutor] executeTool completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
            return result;
        }
        case 'transform': {
            console.log(`[StepExecutor] Calling executeTransform...`);
            const result = await executeTransform(step.config as TransformStepConfig, state);
            console.log(`[StepExecutor] executeTransform completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
            return result;
        }
        case 'conditional': {
            console.log(`[StepExecutor] Calling executeConditional...`);
            const result = executeConditional(step.config as ConditionalStepConfig, state);
            console.log(`[StepExecutor] executeConditional completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
            return result;
        }
        case 'loop': {
            console.log(`[StepExecutor] Calling executeLoop...`);
            const result = await executeLoop(step.config as LoopStepConfig, state);
            console.log(`[StepExecutor] executeLoop completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
            return result;
        }
        case 'connection': {
            console.log(`[StepExecutor] Calling executeConnection...`);
            const result = await executeConnection(step.config as ConnectionStepConfig, state);
            console.log(`[StepExecutor] executeConnection completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
            return result;
        }
        case 'delay': {
            const delayMs = (step.config as any)?.ms ?? 1000;
            console.log(`[StepExecutor] Executing delay: ${delayMs}ms`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            console.log(`[StepExecutor] Delay completed`);
            return {};
        }
        case 'graph': {
            console.log(`[StepExecutor] Calling executeGraph for subgraph: ${(step.config as GraphStepConfig).graphId}`);
            const result = await executeGraph(step.config as GraphStepConfig, state);
            console.log(`[StepExecutor] executeGraph completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
            return result;
        }
        default:
            console.log(`[StepExecutor] ERROR: Unknown step type: ${step.type}`);
            throw new Error(`Unknown step type: ${step.type}`);
    }
}

function evaluateStepCondition(condition: string, state: any): boolean {
    try {
        // resolveValue handles {{...}} pure expressions with type preservation,
        // mixed strings via renderTemplate, and plain strings as-is.
        const result = resolveValue(condition, state);
        return Boolean(result);
    } catch (error) {
        console.error('[StepExecutor] Failed to evaluate condition:', condition, error);
        return false;
    }
}
