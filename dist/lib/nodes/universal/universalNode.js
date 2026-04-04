"use strict";
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
exports.universalNode = void 0;
exports.validateUniversalNodeConfig = validateUniversalNodeConfig;
const stepExecutor_1 = require("./stepExecutor");
const node_helpers_1 = require("../../utils/node-helpers");
// Debug logging - set to true to enable verbose logs
const DEBUG = false;
/**
 * Create an event publisher from RunPublisher
 * Returns null if no RunPublisher is available (events will be skipped)
 */
function createNodeEventPublisher(state) {
    // Use RunPublisher from run
    if (state.runPublisher) {
        const runPublisher = state.runPublisher;
        return {
            nodeStart: (nodeId, nodeType, nodeName) => runPublisher.nodeStart(nodeId, nodeType, nodeName),
            nodeProgress: (nodeId, step, options) => runPublisher.nodeProgress(nodeId, step, options),
            nodeComplete: (nodeId, nextNodeId, output) => runPublisher.nodeComplete(nodeId, nextNodeId, output),
            nodeError: (nodeId, error) => runPublisher.nodeError(nodeId, error),
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
const universalNode = (state) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    // Extract node config (injected by compiler)
    let nodeConfig = state.nodeConfig || {};
    // Extract graph-level parameter overrides (passed from graph node config)
    let graphParameters = Object.assign({}, (nodeConfig.parameters || {}));
    // Merge automation configOverrides if present (runtime overrides from automation edit page)
    const graphNodeId_temp = nodeConfig.graphNodeId || nodeConfig.nodeId || 'universal';
    const runtimeOverrides = state.data && state.data.input && state.data.input._configOverrides
        ? (state.data.input._configOverrides[graphNodeId_temp] || {})
        : {};
    if (Object.keys(runtimeOverrides).length > 0) {
        graphParameters = Object.assign(Object.assign({}, graphParameters), runtimeOverrides);
        if (DEBUG)
            console.log(`[UniversalNode] Applied ${Object.keys(runtimeOverrides).length} runtime config override(s) for ${graphNodeId_temp}`);
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
        const { getUniversalNode, getUniversalNodeRaw } = require('../../registry/UniversalNodeRegistry');
        // Import Node model helpers (dist-only module)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { parametersMapToObject, validateParameters, resolveParameters } = require('../../models/Node');
        // Load full config from MongoDB
        const loadedConfig = yield getUniversalNode(nodeId);
        if (!loadedConfig) {
            throw new Error(`[UniversalNode] Config not found in registry: ${nodeId}`);
        }
        // Also load raw config to get parameter definitions
        const rawNode = yield getUniversalNodeRaw(nodeId);
        // Process parameters if node has parameter definitions
        if (rawNode === null || rawNode === void 0 ? void 0 : rawNode.parameters) {
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
            loadedConfig.resolvedParameters = resolvedParams;
        }
        // Use the loaded config directly (registry already formats it correctly)
        nodeConfig = loadedConfig;
        if (DEBUG)
            console.log(`[UniversalNode] Loaded config for ${nodeId} (${((_a = nodeConfig.steps) === null || _a === void 0 ? void 0 : _a.length) || 0} steps)`);
    }
    // Generate system prefix for this node execution
    const currentNodeCount = state.nodeCounter || 1;
    const nodeName = nodeConfig.name || nodeConfig.nodeId || 'Universal Node';
    const systemPrefix = (0, node_helpers_1.getNodeSystemPrefix)(currentNodeCount, nodeName);
    // Inject into state for steps to use (e.g. in neuronExecutor)
    state.systemPrefix = systemPrefix;
    // Inject resolved parameters into state for template rendering
    if (nodeConfig.resolvedParameters) {
        state.parameters = nodeConfig.resolvedParameters;
    }
    if (DEBUG)
        console.log(`[UniversalNode] Executing node ${currentNodeCount}: ${nodeName}`);
    // Create unified event publisher (prefers RunPublisher, falls back to GraphEventPublisher)
    const eventPublisher = createNodeEventPublisher(state);
    // No need to log publisher status - it's normal to have or not have one
    // Publish node start event
    if (eventPublisher) {
        const nodeType = nodeConfig.type || 'universal';
        yield eventPublisher.nodeStart(graphNodeId, nodeType, nodeName);
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
            type: nodeConfig.type,
            config: nodeConfig.config
        }
    ];
    // Validate steps array
    if (!steps || steps.length === 0) {
        throw new Error('[UniversalNode] Invalid config: steps array cannot be empty');
    }
    // Track state updates from all steps (stored at top-level state)
    const stateUpdates = {
        nodeCounter: currentNodeCount + 1
    };
    // Execute steps sequentially
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepNumber = i + 1;
        console.log(`[UniversalNode] Executing step ${stepNumber}/${steps.length}: ${step.type}`);
        // Publish step progress event
        if (eventPublisher) {
            const stepName = step.name || step.type;
            yield eventPublisher.nodeProgress(graphNodeId, stepName, {
                index: i,
                total: steps.length,
                data: { stepType: step.type }
            });
        }
        try {
            // Set current step index in state
            // This allows respond.ts to know which step is currently executing
            state._currentStepIndex = i;
            // Execute step with current accumulated state
            // Each step can read:
            // - Original state fields (state.query, state.userId, etc.)
            // - Fields set by previous steps/nodes (state.contextMessages, state.routeDecision, etc.)
            // Convert flat updates to nested and deep merge with state
            const nestedUpdates = convertFlatToNested(stateUpdates);
            const currentState = deepMergeObjects(state, nestedUpdates);
            // Pass state (which contains infrastructure) to step executor
            const stepUpdate = yield (0, stepExecutor_1.executeStep)(step, currentState);
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
                const value = stepUpdate[field];
                if (DEBUG) {
                    let valuePreview;
                    if (value === undefined) {
                        valuePreview = 'undefined';
                    }
                    else if (value === null) {
                        valuePreview = 'null';
                    }
                    else if (typeof value === 'string') {
                        valuePreview = value.length > 100 ? value.substring(0, 100) + '...' : value;
                    }
                    else {
                        const stringified = JSON.stringify(value);
                        valuePreview = stringified.length > 100
                            ? stringified.substring(0, 100) + '...'
                            : stringified;
                    }
                    console.log(`[UniversalNode]   ${field} = ${valuePreview}`);
                }
            }
        }
        catch (error) {
            // Provide detailed error context
            const errorMessage = `Step ${stepNumber} (${step.type}) failed: ${error.message}`;
            console.error(`[UniversalNode] ${errorMessage}`);
            // Publish node error event
            if (eventPublisher) {
                // Note: willRetry context is handled by graph compiler routing to error_handler
                yield eventPublisher.nodeError(graphNodeId, errorMessage);
            }
            // Safe stringify for step config (avoid circular references)
            try {
                console.error(`[UniversalNode] Step config:`, JSON.stringify(step.config, null, 2));
            }
            catch (_d) {
                console.error(`[UniversalNode] Step config: [contains circular references]`);
            }
            // Return error state to trigger fallback
            // This allows the graph compiler to route to the error_handler node
            if (DEBUG)
                console.log(`[UniversalNode] Triggering error fallback to 'error_handler'`);
            // Convert flat updates to nested before returning
            const nestedUpdates = convertFlatToNested(stateUpdates);
            return Object.assign(Object.assign({}, nestedUpdates), { data: Object.assign(Object.assign({}, nestedUpdates.data), { error: errorMessage, nextGraph: 'error_handler' }) });
        }
    }
    // Publish node complete event
    if (eventPublisher) {
        // Try to determine next node from routing decision
        const nextNodeId = stateUpdates['data.routeDecision'] || stateUpdates['data.nextGraph'];
        yield eventPublisher.nodeComplete(graphNodeId, nextNodeId);
    }
    if (DEBUG) {
        console.log(`[UniversalNode] All ${steps.length} step(s) completed.`, `Updated fields:`, Object.keys(stateUpdates).join(', '));
    }
    // Convert flat dot-notation keys to nested objects
    // Example: { 'data.executionPlan': {...} } → { data: { executionPlan: {...} } }
    const nestedUpdates = convertFlatToNested(stateUpdates);
    // Debug: Log what we're returning, especially if it contains messages
    if (stateUpdates['data.messages'] !== undefined || (nestedUpdates.data && 'messages' in nestedUpdates.data)) {
        console.log('[UniversalNode] RETURNING WITH MESSAGES:', {
            flatKey: 'data.messages' in stateUpdates,
            nestedData: nestedUpdates.data ? Object.keys(nestedUpdates.data) : 'no data',
            messagesLength: (_c = (_b = nestedUpdates.data) === null || _b === void 0 ? void 0 : _b.messages) === null || _c === void 0 ? void 0 : _c.length
        });
    }
    // Return accumulated state updates
    // LangGraph will merge these using field-specific reducers
    return nestedUpdates;
});
exports.universalNode = universalNode;
/**
 * Convert flat dot-notation object to nested object
 * Example: { 'data.executionPlan': {...}, 'data.hasPlan': true }
 *       → { data: { executionPlan: {...}, hasPlan: true } }
 */
function convertFlatToNested(flat) {
    const nested = {};
    for (const [key, value] of Object.entries(flat)) {
        if (!key.includes('.')) {
            // Top-level field, set directly
            nested[key] = value;
        }
        else {
            // Nested field with dot notation
            const parts = key.split('.');
            let current = nested;
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
function deepMergeObjects(target, source, depth = 0, seen = new WeakSet()) {
    // Protect against excessive depth (likely circular or very deep nesting)
    if (depth > 20) {
        if (DEBUG)
            console.warn('[deepMergeObjects] Max depth reached, returning target with source overlay');
        // Still merge at top level, just don't go deeper
        return Object.assign(Object.assign({}, target), source);
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
        return Object.assign(Object.assign({}, target), source);
    }
    // Track source object to detect circular references
    seen.add(source);
    // Start with all keys from target
    const result = Object.assign({}, target);
    for (const key of Object.keys(source)) {
        const sourceValue = source[key];
        const targetValue = result[key];
        if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
            // Recursively merge nested objects
            result[key] = deepMergeObjects(targetValue || {}, sourceValue, depth + 1, seen);
        }
        else {
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
function validateUniversalNodeConfig(nodeConfig) {
    // Check for configuration format
    if (!nodeConfig.steps && (!nodeConfig.type || !nodeConfig.config)) {
        throw new Error('Invalid universal node config: must provide either "steps" array or "type" + "config"');
    }
    // Get steps array
    const steps = nodeConfig.steps || [
        {
            type: nodeConfig.type,
            config: nodeConfig.config
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
        const validTypes = ['neuron', 'tool', 'transform', 'conditional', 'loop'];
        if (!validTypes.includes(step.type)) {
            throw new Error(`Step ${stepNumber}: invalid type "${step.type}". Must be one of: ${validTypes.join(', ')}`);
        }
        // Type-specific validation
        const config = step.config;
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
