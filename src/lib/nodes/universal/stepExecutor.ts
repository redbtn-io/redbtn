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
import { resolveValue, renderTemplate } from './templateRenderer';
import { runControlRegistry } from '../../run/RunControlRegistry';
import { executeNeuron } from './executors/neuronExecutor';
import { executeTool } from './executors/toolExecutor';
import { executeTransform } from './executors/transformExecutor';
import { executeConditional } from './executors/conditionalExecutor';
import { executeLoop } from './executors/loopExecutor';
import { executeConnection } from './executors/connectionExecutor';
import { executeGraph } from './executors/graphExecutor';

/**
 * Resolve the run-level AbortSignal — see universalNode.ts for the full
 * rationale. Reads from the per-process RunControlRegistry (survives
 * checkpoint round-trips), with `state._abortController` as a fallback for
 * direct/test callers.
 */
export function getRunSignal(state: any): AbortSignal | undefined {
    const runId = state?.runId || state?.data?.runId;
    const ctx = runControlRegistry.get(runId);
    if (ctx) return ctx.controller.signal;
    return state?._abortController?.signal;
}

/**
 * Execute a single step based on its type
 *
 * @param step - Step configuration with type and config
 * @param state - Current state (includes original state + accumulated updates from previous steps)
 * @returns Partial state update from this step
 * @throws Error if step type is unknown or execution fails
 */
export async function executeStep(
  step: UniversalStep,
  state: any,
  parameters: Record<string, any> = {},
): Promise<Partial<any>> {
    console.log(`[StepExecutor] ====== EXECUTING STEP: ${step.type} ======`);
    console.log(`[StepExecutor] Step config keys:`, Object.keys(step.config || {}));
    // Check optional condition
    if (step.condition) {
        console.log(`[StepExecutor] Checking condition: ${step.condition}`);
        // Pass state DIRECTLY (not wrapped). The condition templates reference
        // `state.data.foo` and `parameters.foo` — those keys are direct children
        // of `state`, so wrapping in `{state, parameters}` would make every such
        // path look up `wrapper.data.*` → undefined. Pre-0.0.139 the failure
        // path returned the original template string and Boolean()-coerced it to
        // true (every condition silently truthy), masking the bug. PR #168's
        // fail-loud behavior surfaced it; this fix removes the wrapper. The
        // `parameters` arg is merged in so explicit `parameters.X` templates
        // keep working even if the parent state doesn't carry parameters.
        const shouldRun = evaluateStepCondition(step.condition, { ...state, parameters });
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
            const result = await executeLoop(step.config as LoopStepConfig, state, parameters);
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
            const rawMs = (step.config as any)?.ms ?? 1000;
            const renderedMs = renderTemplate(String(rawMs), { state, parameters });
            const delayMs = parseInt(renderedMs, 10) || 1000;
            console.log(`[StepExecutor] Executing delay: ${delayMs}ms (rendered from: ${rawMs})`);
            // Abort-aware delay: respect the run-level AbortSignal so a long
            // delay in a node step yields immediately on external interrupt
            // instead of blocking until the timeout fires. The thrown error
            // surfaces as a step failure; universalNode's between-step abort
            // check at the next boundary translates it to clean cancellation.
            // Signal comes from RunControlRegistry (survives checkpoint
            // round-trips, unlike state-stashed controllers).
            const signal: AbortSignal | undefined = getRunSignal(state);
            await new Promise<void>((resolve, reject) => {
                if (signal?.aborted) {
                    reject(new Error('Delay aborted'));
                    return;
                }
                let timer: ReturnType<typeof setTimeout> | null = null;
                const onAbort = () => {
                    if (timer !== null) {
                        clearTimeout(timer);
                        timer = null;
                    }
                    reject(new Error('Delay aborted'));
                };
                timer = setTimeout(() => {
                    timer = null;
                    if (signal) signal.removeEventListener('abort', onAbort);
                    resolve();
                }, delayMs);
                if (signal) {
                    signal.addEventListener('abort', onAbort, { once: true });
                }
            });
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

function normalizeDelayMs(value: any): number {
    const delayMs =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim() !== ''
                ? Number(value)
                : NaN;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
        return 1000;
    }
    return delayMs;
}

function evaluateStepCondition(condition: string, state: any): boolean {
    // resolveValue handles {{...}} pure expressions with type preservation,
    // mixed strings via renderTemplate, and plain strings as-is. It also
    // catches eval errors internally and returns the *original string* on
    // failure — detect that here and surface as a loud error rather than a
    // silent false (which would skip the step without any author-visible
    // signal).
    const result = resolveValue(condition, state);
    if (typeof condition === 'string' && typeof result === 'string' && result === condition) {
        const trimmed = condition.trim();
        if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
            throw new Error(
                `Step condition failed to evaluate: ${condition}. ` +
                `Check that the expression is valid JavaScript and that all referenced state paths exist.`
            );
        }
    }
    return Boolean(result);
}
