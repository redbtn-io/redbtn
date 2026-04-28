/**
 * Universal Node Orchestrator
 *
 * Main entry point for universal nodes. Handles:
 * - Normalizing single-step and multi-step configurations
 * - Executing steps sequentially
 * - Accumulating state updates across steps
 * - Error handling with step context
 * - Parameter resolution (merging node defaults with graph overrides)
 *
 * Universal nodes can have 1-N steps that execute in order, with each step
 * able to read state fields set by previous steps.
 *
 * Parameters System:
 * - Nodes define exposed parameters with defaults in their config
 * - Graphs can override parameters via nodeConfig.parameters
 * - Resolved parameters are available as {{parameters.xxx}} in templates
 */

import { executeStep } from './stepExecutor';
import { getNodeSystemPrefix } from '../../utils/node-helpers';
import type { NodeConfig } from './types';

// Debug logging - set to true to enable verbose logs
const DEBUG = false;

/**
 * Lightweight inline sentinel — must mirror RunInterruptedError in
 * `functions/run.ts`. We avoid importing from there to dodge circular deps
 * (this module is loaded by the graph compiler which is loaded by run.ts).
 *
 * The outer execution wrapper checks `error.name === 'RunInterruptedError'`
 * to route to publisher.interrupt() instead of publisher.fail().
 */
class RunInterruptedError extends Error {
    readonly name = 'RunInterruptedError';
    constructor(public readonly reason?: string) {
        super(reason ? `Run interrupted: ${reason}` : 'Run interrupted');
    }
}

/**
 * Check the abort signal that `run()` stashes on `state._abortController`.
 * Throws RunInterruptedError if the external `run:interrupt:{runId}` channel
 * has been triggered. Called at the top of every node invocation and
 * between steps so cancellation lands cleanly between checkpointed boundaries.
 */
function checkAbort(state: any): void {
    const signal = state?._abortController?.signal;
    if (signal?.aborted) {
        const reason = signal.reason as { reason?: string } | string | undefined;
        const reasonStr =
            typeof reason === 'string'
                ? reason
                : reason && typeof (reason as any).reason === 'string'
                    ? (reason as any).reason
                    : undefined;
        throw new RunInterruptedError(reasonStr);
    }
}

/**
 * Create an event publisher from RunPublisher
 * Returns null if no RunPublisher is available (events will be skipped)
 */
function createNodeEventPublisher(state: any): {
    nodeStart: (nodeId: string, nodeType: string, nodeName: string) => Promise<void>;
    nodeProgress: (nodeId: string, step: string, options: any) => Promise<void>;
    nodeComplete: (nodeId: string, nextNodeId: any, output?: any) => Promise<void>;
    nodeError: (nodeId: string, error: string) => Promise<void>;
} | null {
    // Use RunPublisher from run
    if (state.runPublisher) {
        const runPublisher = state.runPublisher;
        return {
            nodeStart: (nodeId: string, nodeType: string, nodeName: string) => runPublisher.nodeStart(nodeId, nodeType, nodeName),
            nodeProgress: (nodeId: string, step: string, options: any) => runPublisher.nodeProgress(nodeId, step, options),
            nodeComplete: (nodeId: string, nextNodeId: any, output?: any) => runPublisher.nodeComplete(nodeId, nextNodeId, output),
            nodeError: (nodeId: string, error: string) => runPublisher.nodeError(nodeId, error),
        };
    }
    // No publisher available - events will be skipped
    return null;
}

/**
 * Universal node function — the single execution entry point for all graph nodes.
 *
 * Config is loaded from MongoDB by nodeId. Supports two modes:
 * This follows the same pattern as other configurable nodes (responder, context, etc.)
 *
 * Supports two configuration modes:
 * 1. Legacy: Full config with steps embedded (for backward compatibility)
 * 2. Registry: nodeId reference to load config from MongoDB (new approach)
 *
 * Parameters:
 * - Graph can pass parameters: { nodeId: "router", parameters: { temperature: 0.3 } }
 * - These are merged with node's default parameters
 * - Available in templates as {{parameters.temperature}}
 *
 * @param state - Graph state with nodeConfig injected by compiler
 * @returns Partial state with updates from all executed steps
 */
export const universalNode = async (state: any): Promise<Partial<any>> => {
    // External-interrupt check at the top of every node invocation.
    // MongoCheckpointer has already persisted state at the prior node's exit,
    // so throwing here gives a clean checkpoint boundary for resume.
    checkAbort(state);

    // Extract node config (injected by compiler)
    let nodeConfig: NodeConfig = state.nodeConfig || {};

    // Extract graph-level parameter overrides (passed from graph node config)
    let graphParameters: Record<string, any> = { ...((nodeConfig.parameters as Record<string, any>) || {}) };

    // Merge automation configOverrides if present (runtime overrides from automation edit page)
    const graphNodeId_temp = (nodeConfig as any).graphNodeId || nodeConfig.nodeId || 'universal';
    const runtimeOverrides: Record<string, any> =
        state.data && state.data.input && state.data.input._configOverrides
            ? (state.data.input._configOverrides[graphNodeId_temp] || {})
            : {};
    if (Object.keys(runtimeOverrides).length > 0) {
        graphParameters = { ...graphParameters, ...runtimeOverrides };
        if (DEBUG) console.log(`[UniversalNode] Applied ${Object.keys(runtimeOverrides).length} runtime config override(s) for ${graphNodeId_temp}`);
    }

    // graphNodeId is the unique node instance ID in the graph (used for event publishing)
    // nodeId is the registry lookup key (can be node type like "context" or explicit custom node ID)
    const graphNodeId = graphNodeId_temp;
    const nodeId = nodeConfig.nodeId || 'universal';

    // Check if this is a nodeId reference (registry mode)
    if (nodeConfig.nodeId && !nodeConfig.steps) {
        if (DEBUG)
            console.log(`[UniversalNode] Loading config from registry: ${nodeId}`);

        // Import registry dynamically to avoid circular dependencies
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getUniversalNode, getUniversalNodeRaw } = require('../../registry/UniversalNodeRegistry') as {
            getUniversalNode: (nodeId: string) => Promise<any>;
            getUniversalNodeRaw: (nodeId: string) => Promise<any>;
        };
        // Import Node model helpers (dist-only module)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { parametersMapToObject, validateParameters, resolveParameters } = require('../../models/Node') as {
            parametersMapToObject: (params: any) => any;
            validateParameters: (params: any, schema: any) => any;
            resolveParameters: (params: any, overrides: any) => any;
        };

        // Load full config from MongoDB
        const loadedConfig = await getUniversalNode(nodeId);
        if (!loadedConfig) {
            throw new Error(`[UniversalNode] Config not found in registry: ${nodeId}`);
        }

        // Also load raw config to get parameter definitions
        const rawNode = await getUniversalNodeRaw(nodeId);

        // Process parameters if node has parameter definitions
        if (rawNode?.parameters) {
            const parameterDefs = parametersMapToObject(rawNode.parameters);

            // Validate graph-provided parameters
            const validationErrors = validateParameters(graphParameters, parameterDefs);
            if (validationErrors.length > 0) {
                console.warn(`[UniversalNode] Parameter validation warnings for ${nodeId}:`, validationErrors);
                // Don't throw - just warn and continue with valid values
            }

            // Resolve parameters (merge defaults with graph overrides)
            const resolvedParams = resolveParameters(parameterDefs, graphParameters);
            if (DEBUG)
                console.log(`[UniversalNode] Resolved parameters for ${nodeId}:`, resolvedParams);

            // Attach resolved parameters to config for use in templates
            (loadedConfig as any).resolvedParameters = resolvedParams;
        }

        // Use the loaded config directly (registry already formats it correctly)
        nodeConfig = loadedConfig;
        if (DEBUG)
            console.log(`[UniversalNode] Loaded config for ${nodeId} (${nodeConfig.steps?.length || 0} steps)`);
    }

    // Generate system prefix for this node execution
    const currentNodeCount = state.nodeCounter || 1;
    const nodeName = nodeConfig.name || nodeConfig.nodeId || 'Universal Node';
    const systemPrefix = getNodeSystemPrefix(currentNodeCount, nodeName);

    // Inject into state for steps to use (e.g. in neuronExecutor)
    state.systemPrefix = systemPrefix;

    // Inject resolved parameters into state for template rendering
    if ((nodeConfig as any).resolvedParameters) {
        state.parameters = (nodeConfig as any).resolvedParameters;
    }

    if (DEBUG)
        console.log(`[UniversalNode] Executing node ${currentNodeCount}: ${nodeName}`);

    // Create unified event publisher (prefers RunPublisher, falls back to GraphEventPublisher)
    const eventPublisher = createNodeEventPublisher(state);

    // No need to log publisher status - it's normal to have or not have one

    // Publish node start event
    if (eventPublisher) {
        const nodeType = (nodeConfig as any).type || 'universal';
        await eventPublisher.nodeStart(graphNodeId, nodeType, nodeName);
    }

    const nodeStartTime = Date.now();

    // Validate configuration
    if (!nodeConfig.steps && (!nodeConfig.type || !nodeConfig.config)) {
        throw new Error('[UniversalNode] Invalid config: must provide either "steps" array or "type" + "config"');
    }

    // Normalize to array of steps
    // Single-step format: { type: 'neuron', config: {...} }
    // Multi-step format: { steps: [...] }
    const steps = nodeConfig.steps || [
        {
            type: nodeConfig.type!,
            config: nodeConfig.config!
        }
    ];

    // Validate steps array
    if (!steps || steps.length === 0) {
        throw new Error('[UniversalNode] Invalid config: steps array cannot be empty');
    }

    // Track state updates from all steps (stored at top-level state)
    const stateUpdates: Record<string, any> = {
        nodeCounter: currentNodeCount + 1
    };

    // Execute steps sequentially
    for (let i = 0; i < steps.length; i++) {
        // Between-step abort check — bails immediately on external interrupt
        // without leaving a half-completed step on the state.
        checkAbort(state);

        const step = steps[i];
        const stepNumber = i + 1;

        console.log(`[UniversalNode] Executing step ${stepNumber}/${steps.length}: ${step.type}`);

        // Publish step progress event
        if (eventPublisher) {
            const stepName = (step as any).name || step.type;
            await eventPublisher.nodeProgress(graphNodeId, stepName, {
                index: i,
                total: steps.length,
                data: { stepType: step.type }
            });
        }

        try {
            // Set current step index in state
            // Used by streaming execution path to track which step is executing
            state._currentStepIndex = i;

            // Execute step with current accumulated state
            // Each step can read:
            // - Original state fields (state.query, state.userId, etc.)
            // - Fields set by previous steps/nodes (state.contextMessages, state.routeDecision, etc.)

            // Convert flat updates to nested and deep merge with state
            const nestedUpdates = convertFlatToNested(stateUpdates);
            const currentState = deepMergeObjects(state, nestedUpdates);

            // Pass state (which contains infrastructure) to step executor
            const stepUpdate = await executeStep(step, currentState);

            // Accumulate state updates at top level (still flat for now)
            Object.assign(stateUpdates, stepUpdate);

            // Clear step index after execution
            state._currentStepIndex = undefined;

            const updatedFields = Object.keys(stepUpdate);
            if (DEBUG) {
                console.log(`[UniversalNode] Step ${stepNumber} completed. Updated fields:`, updatedFields.join(', '));
            }

            // Log the actual values for debugging routing issues
            for (const field of updatedFields) {
                const value = (stepUpdate as any)[field];
                if (DEBUG) {
                    let valuePreview: string;
                    if (value === undefined) {
                        valuePreview = 'undefined';
                    } else if (value === null) {
                        valuePreview = 'null';
                    } else if (typeof value === 'string') {
                        valuePreview = value.length > 100 ? value.substring(0, 100) + '...' : value;
                    } else {
                        const stringified = JSON.stringify(value);
                        valuePreview = stringified.length > 100
                            ? stringified.substring(0, 100) + '...'
                            : stringified;
                    }
                    console.log(`[UniversalNode]   ${field} = ${valuePreview}`);
                }
            }
        } catch (error: any) {
            // External-interrupt sentinel — re-throw so the run wrapper can
            // route to publisher.interrupt() instead of treating this as a
            // generic error and triggering the error_handler fallback.
            // MongoCheckpointer has the prior-node state; resuming will
            // skip whatever this node was working on.
            if (error?.name === 'RunInterruptedError') {
                throw error;
            }

            // Provide detailed error context
            const errorMessage = `Step ${stepNumber} (${step.type}) failed: ${error.message}`;
            console.error(`[UniversalNode] ${errorMessage}`);

            // Publish node error event
            if (eventPublisher) {
                // Note: willRetry context is handled by graph compiler routing to error_handler
                await eventPublisher.nodeError(graphNodeId, errorMessage);
            }

            // Safe stringify for step config (avoid circular references)
            try {
                console.error(`[UniversalNode] Step config:`, JSON.stringify(step.config, null, 2));
            } catch {
                console.error(`[UniversalNode] Step config: [contains circular references]`);
            }

            // Return error state to trigger fallback
            // This allows the graph compiler to route to the error_handler node
            if (DEBUG)
                console.log(`[UniversalNode] Triggering error fallback to 'error_handler'`);

            // Convert flat updates to nested before returning
            const nestedUpdates = convertFlatToNested(stateUpdates);
            return {
                ...nestedUpdates,
                data: {
                    ...nestedUpdates.data,
                    error: errorMessage,
                    nextGraph: 'error_handler'
                }
            };
        }
    }

    // Final between-step abort check (after the last step but before
    // we publish nodeComplete + return state).
    checkAbort(state);

    // Publish node complete event
    if (eventPublisher) {
        // Try to determine next node from routing decision
        const nextNodeId = stateUpdates['data.routeDecision'] || stateUpdates['data.nextGraph'];
        await eventPublisher.nodeComplete(graphNodeId, nextNodeId);
    }

    if (DEBUG) {
        console.log(
            `[UniversalNode] All ${steps.length} step(s) completed.`,
            `Updated fields:`,
            Object.keys(stateUpdates).join(', ')
        );
    }

    // Convert flat dot-notation keys to nested objects
    // Example: { 'data.executionPlan': {...} } → { data: { executionPlan: {...} } }
    const nestedUpdates = convertFlatToNested(stateUpdates);

    // Debug: Log what we're returning, especially if it contains messages
    if (stateUpdates['data.messages'] !== undefined || (nestedUpdates.data && 'messages' in nestedUpdates.data)) {
        console.log('[UniversalNode] RETURNING WITH MESSAGES:', {
            flatKey: 'data.messages' in stateUpdates,
            nestedData: nestedUpdates.data ? Object.keys(nestedUpdates.data) : 'no data',
            messagesLength: nestedUpdates.data?.messages?.length
        });
    }

    // Return accumulated state updates
    // LangGraph will merge these using field-specific reducers
    return nestedUpdates;
};

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
        } else {
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
 * Deep merge two objects, merging nested objects recursively
 * Includes protection against circular references and deep nesting
 */
function deepMergeObjects(target: any, source: any, depth = 0, seen = new WeakSet()): any {
    // Protect against excessive depth (likely circular or very deep nesting)
    if (depth > 20) {
        if (DEBUG)
            console.warn('[deepMergeObjects] Max depth reached, returning target with source overlay');
        // Still merge at top level, just don't go deeper
        return { ...target, ...source };
    }

    // If source is null/undefined, return target
    if (source === null || source === undefined) {
        return target;
    }

    // If target is not an object, just return source
    if (!target || typeof target !== 'object') {
        return source;
    }

    // If source is not an object, return source (overwrites target)
    if (typeof source !== 'object') {
        return source;
    }

    // Protect against circular references in source
    if (seen.has(source)) {
        // For circular refs, merge what we can at this level without recursing
        return { ...target, ...source };
    }

    // Track source object to detect circular references
    seen.add(source);

    // Start with all keys from target
    const result: Record<string, any> = { ...target };

    for (const key of Object.keys(source)) {
        const sourceValue = source[key];
        const targetValue = result[key];

        if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
            // Recursively merge nested objects
            result[key] = deepMergeObjects(targetValue || {}, sourceValue, depth + 1, seen);
        } else {
            // Directly assign primitives, arrays, and null values
            result[key] = sourceValue;
        }
    }

    return result;
}

/**
 * Validate a universal node configuration
 *
 * Checks for common configuration errors before execution.
 * Useful for API validation when users create graphs.
 *
 * @param nodeConfig - Configuration to validate
 * @throws Error if configuration is invalid
 */
export function validateUniversalNodeConfig(nodeConfig: NodeConfig): void {
    // Check for configuration format
    if (!nodeConfig.steps && (!nodeConfig.type || !nodeConfig.config)) {
        throw new Error('Invalid universal node config: must provide either "steps" array or "type" + "config"');
    }

    // Get steps array
    const steps = nodeConfig.steps || [
        {
            type: nodeConfig.type!,
            config: nodeConfig.config!
        }
    ];

    // Validate steps array
    if (!steps || steps.length === 0) {
        throw new Error('Invalid universal node config: steps array cannot be empty');
    }

    // Validate each step
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepNumber = i + 1;

        if (!step.type) {
            throw new Error(`Step ${stepNumber}: missing "type" field`);
        }

        if (!step.config) {
            throw new Error(`Step ${stepNumber}: missing "config" field`);
        }

        const validTypes = ['neuron', 'tool', 'transform', 'conditional', 'loop', 'delay', 'connection', 'graph'];
        if (!validTypes.includes(step.type)) {
            throw new Error(`Step ${stepNumber}: invalid type "${step.type}". Must be one of: ${validTypes.join(', ')}`);
        }

        // Type-specific validation
        const config = step.config as any;

        switch (step.type) {
            case 'neuron':
                if (!config.userPrompt) {
                    throw new Error(`Step ${stepNumber} (neuron): missing required field "userPrompt"`);
                }
                if (!config.outputField) {
                    throw new Error(`Step ${stepNumber} (neuron): missing required field "outputField"`);
                }
                break;

            case 'tool':
                if (!config.toolName) {
                    throw new Error(`Step ${stepNumber} (tool): missing required field "toolName"`);
                }
                if (!config.outputField) {
                    throw new Error(`Step ${stepNumber} (tool): missing required field "outputField"`);
                }
                if (!config.parameters) {
                    throw new Error(`Step ${stepNumber} (tool): missing required field "parameters"`);
                }
                break;

            case 'transform':
                if (!config.operation) {
                    throw new Error(`Step ${stepNumber} (transform): missing required field "operation"`);
                }
                if (!config.inputField) {
                    throw new Error(`Step ${stepNumber} (transform): missing required field "inputField"`);
                }
                if (!config.outputField) {
                    throw new Error(`Step ${stepNumber} (transform): missing required field "outputField"`);
                }
                const validOps = ['map', 'filter', 'select'];
                if (!validOps.includes(config.operation)) {
                    throw new Error(`Step ${stepNumber} (transform): invalid operation "${config.operation}". Must be one of: ${validOps.join(', ')}`);
                }
                break;

            case 'conditional':
                if (!config.condition) {
                    throw new Error(`Step ${stepNumber} (conditional): missing required field "condition"`);
                }
                if (!config.setField) {
                    throw new Error(`Step ${stepNumber} (conditional): missing required field "setField"`);
                }
                if (config.trueValue === undefined) {
                    throw new Error(`Step ${stepNumber} (conditional): missing required field "trueValue"`);
                }
                if (config.falseValue === undefined) {
                    throw new Error(`Step ${stepNumber} (conditional): missing required field "falseValue"`);
                }
                break;

            case 'loop':
                if (!config.maxIterations || config.maxIterations < 1) {
                    throw new Error(`Step ${stepNumber} (loop): missing or invalid "maxIterations" (must be >= 1)`);
                }
                if (!config.exitCondition) {
                    throw new Error(`Step ${stepNumber} (loop): missing required field "exitCondition"`);
                }
                if (!config.steps || config.steps.length === 0) {
                    throw new Error(`Step ${stepNumber} (loop): missing or empty "steps" array`);
                }
                // Recursively validate nested loop steps
                for (let i = 0; i < config.steps.length; i++) {
                    const nestedStep = config.steps[i];
                    if (!nestedStep.type || !nestedStep.config) {
                        throw new Error(`Step ${stepNumber} (loop): nested step ${i + 1} missing "type" or "config"`);
                    }
                }
                break;
        }
    }
}
