"use strict";
/**
 * Step Executor Dispatcher
 *
 * Routes each step to the appropriate executor based on step type.
 * This is the central dispatch point for all universal node step execution.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeStep = executeStep;
const templateRenderer_1 = require("./templateRenderer");
// These imports resolve from the dist/ directory at runtime — they are
// hand-maintained modules that have no source counterpart in src/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeNeuron } = require('./executors/neuronExecutor');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeTool } = require('./executors/toolExecutor');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeTransform } = require('./executors/transformExecutor');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeConditional } = require('./executors/conditionalExecutor');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeLoop } = require('./executors/loopExecutor');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeConnection } = require('./executors/connectionExecutor');
/**
 * Execute a single step based on its type
 *
 * @param step - Step configuration with type and config
 * @param state - Current state (includes original state + accumulated updates from previous steps)
 * @returns Partial state update from this step
 * @throws Error if step type is unknown or execution fails
 */
function executeStep(step, state) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
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
                const result = yield executeNeuron(step.config, state);
                console.log(`[StepExecutor] executeNeuron completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
                return result;
            }
            case 'tool': {
                console.log(`[StepExecutor] Calling executeTool...`);
                const result = yield executeTool(step.config, state);
                console.log(`[StepExecutor] executeTool completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
                return result;
            }
            case 'transform': {
                console.log(`[StepExecutor] Calling executeTransform...`);
                const result = yield executeTransform(step.config, state);
                console.log(`[StepExecutor] executeTransform completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
                return result;
            }
            case 'conditional': {
                console.log(`[StepExecutor] Calling executeConditional...`);
                const result = executeConditional(step.config, state);
                console.log(`[StepExecutor] executeConditional completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
                return result;
            }
            case 'loop': {
                console.log(`[StepExecutor] Calling executeLoop...`);
                const result = yield executeLoop(step.config, state);
                console.log(`[StepExecutor] executeLoop completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
                return result;
            }
            case 'connection': {
                console.log(`[StepExecutor] Calling executeConnection...`);
                const result = yield executeConnection(step.config, state);
                console.log(`[StepExecutor] executeConnection completed in ${Date.now() - startTime}ms, result keys:`, Object.keys(result || {}));
                return result;
            }
            case 'delay': {
                const delayMs = (_b = (_a = step.config) === null || _a === void 0 ? void 0 : _a.ms) !== null && _b !== void 0 ? _b : 1000;
                console.log(`[StepExecutor] Executing delay: ${delayMs}ms`);
                yield new Promise(resolve => setTimeout(resolve, delayMs));
                console.log(`[StepExecutor] Delay completed`);
                return {};
            }
            default:
                console.log(`[StepExecutor] ERROR: Unknown step type: ${step.type}`);
                throw new Error(`Unknown step type: ${step.type}`);
        }
    });
}
function evaluateStepCondition(condition, state) {
    try {
        // resolveValue handles {{...}} pure expressions with type preservation,
        // mixed strings via renderTemplate, and plain strings as-is.
        const result = (0, templateRenderer_1.resolveValue)(condition, state);
        return Boolean(result);
    }
    catch (error) {
        console.error('[StepExecutor] Failed to evaluate condition:', condition, error);
        return false;
    }
}
