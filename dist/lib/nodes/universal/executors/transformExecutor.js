"use strict";
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
exports.executeTransform = executeTransform;
/**
 * Transform Step Executor
 *
 * Executes data transformations on arrays and objects.
 * Supports map, filter, and select operations with template rendering.
 */
const templateRenderer_1 = require("../templateRenderer");
const json_extractor_1 = require("../../../utils/json-extractor");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getGlobalStateClient } = require('../../../globalState');
// Debug logging - set to true to enable verbose logs
const DEBUG = false;
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
function executeTransform(config, state) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        console.log('[TransformExecutor] ====== STARTING TRANSFORM ======');
        console.log('[TransformExecutor] Operation:', config.operation);
        console.log('[TransformExecutor] InputField:', config.inputField);
        console.log('[TransformExecutor] OutputField:', config.outputField);
        try {
            // build-messages doesn't require inputField
            let inputData = undefined;
            if (config.inputField) {
                // Smart Global State Detection for inputField:
                // If inputField starts with 'globalState.', read from global state
                if (config.inputField.startsWith('globalState.')) {
                    const parts = config.inputField.split('.');
                    if (parts.length < 3) {
                        throw new Error(`Invalid globalState path: ${config.inputField}. Expected format: globalState.namespace.key`);
                    }
                    const namespace = parts[1];
                    const key = parts[2];
                    if (DEBUG)
                        console.log(`[TransformExecutor] Auto-detected global state read: ${namespace}.${key}`);
                    // Pass userId for authentication
                    const client = getGlobalStateClient({
                        userId: ((_a = state.data) === null || _a === void 0 ? void 0 : _a.userId) || state.userId,
                        workflowId: ((_b = state.data) === null || _b === void 0 ? void 0 : _b.graphId) || state.graphId,
                    });
                    inputData = yield client.getValue(namespace, key);
                }
                else {
                    // Get input data from state (handles nested paths)
                    inputData = getNestedProperty(state, config.inputField);
                    // Fallback: try data. prefix if not found (migration support)
                    if (inputData === undefined && !config.inputField.startsWith('data.') && !config.inputField.startsWith('state.')) {
                        const dataPath = `data.${config.inputField}`;
                        const dataValue = getNestedProperty(state, dataPath);
                        if (dataValue !== undefined) {
                            if (DEBUG)
                                console.log(`[TransformExecutor] Using data. prefix for '${config.inputField}'`);
                            inputData = dataValue;
                        }
                    }
                }
            }
            // Append, build-messages, set, set-global, get-global, increment, decrement, and concat (with fallback) operations allow undefined input
            const allowUndefinedInput = config.operation === 'append' ||
                config.operation === 'build-messages' ||
                config.operation === 'set' ||
                config.operation === 'set-global' ||
                config.operation === 'get-global' ||
                config.operation === 'increment' ||
                config.operation === 'decrement' ||
                (config.operation === 'concat' && config.fallbackToConcat);
            if (inputData === undefined && !allowUndefinedInput) {
                throw new Error(`Input field not found in state: ${config.inputField}`);
            }
            // Execute operation
            let result;
            switch (config.operation) {
                case 'map':
                    result = executeMapOperation(config, inputData, state);
                    break;
                case 'filter':
                    result = executeFilterOperation(config, inputData, state);
                    break;
                case 'select':
                    result = executeSelectOperation(config, inputData);
                    break;
                case 'set':
                    result = executeSetOperation(config, state);
                    break;
                case 'json':
                case 'parse-json': // backward compatibility
                    result = executeParseJsonOperation(config, inputData);
                    break;
                case 'append':
                    result = executeAppendOperation(config, inputData, state);
                    break;
                case 'concat':
                    result = executeConcatOperation(config, inputData, state);
                    break;
                case 'build-messages':
                    result = executeBuildMessagesOperation(config, state);
                    break;
                case 'set-global':
                    result = yield executeSetGlobalOperation(config, inputData, state);
                    break;
                case 'get-global':
                    result = yield executeGetGlobalOperation(config, state);
                    break;
                case 'increment':
                    result = executeIncrementOperation(config, inputData, state);
                    break;
                case 'decrement':
                    result = executeDecrementOperation(config, inputData, state);
                    break;
                default:
                    throw new Error(`Unknown transform operation: ${config.operation}`);
            }
            // Smart Global State Detection:
            // If outputField starts with 'globalState.', automatically route to global state storage
            // Example: outputField='globalState.JOEL.counter' -> namespace='JOEL', key='counter'
            if (config.outputField && config.outputField.startsWith('globalState.')) {
                const parts = config.outputField.split('.');
                if (parts.length < 3) {
                    throw new Error(`Invalid globalState path: ${config.outputField}. Expected format: globalState.namespace.key`);
                }
                const namespace = parts[1];
                const key = parts[2];
                if (DEBUG)
                    console.log(`[TransformExecutor] Auto-detected global state: ${namespace}.${key}`);
                // Route to global state storage - pass userId for authentication
                const client = getGlobalStateClient({
                    userId: ((_c = state.data) === null || _c === void 0 ? void 0 : _c.userId) || state.userId,
                    workflowId: ((_d = state.data) === null || _d === void 0 ? void 0 : _d.graphId) || state.graphId,
                });
                const success = yield client.setValue(namespace, key, result, {
                    description: config.description,
                    ttlSeconds: config.ttlSeconds,
                });
                // Return metadata about the operation
                return {
                    _globalStateSet: success,
                    _globalStateKey: `${namespace}.${key}`,
                };
            }
            // Return output field.
            // If an outputField is provided, keep the existing behavior and return
            // a single-field partial state. If no outputField is provided and the
            // result is an object, return that object directly so a single transform
            // step can set multiple fields (useful for initializing/incrementing
            // multiple state keys in one step). Otherwise, fall back to wrapping
            // the primitive result into a `result` field.
            if (config.outputField) {
                return { [config.outputField]: result };
            }
            if (result && typeof result === 'object' && !Array.isArray(result)) {
                // Return object directly as partial state
                return result;
            }
            // Fallback for primitives when no outputField specified
            return { result };
        }
        catch (error) {
            throw new Error(`Transform step failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
}
/**
 * Map operation: Apply transform template to each element
 *
 * Example:
 * inputData: [{ url: "https://..." }, { url: "https://..." }]
 * transform: "{{item.url}}"
 * result: ["https://...", "https://..."]
 */
function executeMapOperation(config, inputData, state) {
    if (!Array.isArray(inputData)) {
        throw new Error('Map operation requires input to be an array');
    }
    if (!config.transform) {
        throw new Error('Map operation requires transform template');
    }
    return inputData.map((item, index) => {
        // Create augmented state with item context
        // renderTemplate extracts the path after "state.", so we add item and index at root
        const itemState = Object.assign(Object.assign({}, state), { item, index });
        // Render transform template with item context
        // Template can use {{state.item.xxx}} or {{state.index}}
        return (0, templateRenderer_1.renderTemplate)(config.transform, itemState);
    });
}
/**
 * Filter operation: Keep elements where condition is true
 *
 * Example:
 * inputData: [{ score: 0.8 }, { score: 0.3 }, { score: 0.9 }]
 * filterCondition: "{{item.score}} > 0.5"
 * result: [{ score: 0.8 }, { score: 0.9 }]
 */
function executeFilterOperation(config, inputData, state) {
    if (!Array.isArray(inputData)) {
        throw new Error('Filter operation requires input to be an array');
    }
    if (!config.filterCondition) {
        throw new Error('Filter operation requires filterCondition');
    }
    return inputData.filter((item, index) => {
        // Create augmented state with item context
        // renderTemplate extracts the path after "state.", so we add item and index at root
        const itemState = Object.assign(Object.assign({}, state), { item, index });
        // Render condition template
        // Template can use {{state.item.xxx}} or {{state.index}}
        const conditionStr = (0, templateRenderer_1.renderTemplate)(config.filterCondition, itemState);
        // Evaluate condition (basic evaluation)
        return evaluateCondition(conditionStr);
    });
}
/**
 * Select operation: Extract nested property
 *
 * Example:
 * inputData: { results: [{ url: "https://..." }] }
 * transform: "results"
 * result: [{ url: "https://..." }]
 *
 * Or with array:
 * inputData: [{ data: { url: "..." } }]
 * transform: "data.url"
 * result: ["...", "..."]
 */
function executeSelectOperation(config, inputData) {
    if (!config.transform) {
        throw new Error('Select operation requires transform (property path)');
    }
    const propertyPath = config.transform;
    // If input is array, extract property from each element
    if (Array.isArray(inputData)) {
        return inputData.map((item) => getNestedProperty(item, propertyPath));
    }
    // Otherwise extract property from input object
    return getNestedProperty(inputData, propertyPath);
}
/**
 * Extract nested property using dot notation
 *
 * @param obj - Object to extract from
 * @param path - Dot-separated path (e.g., "user.profile.name")
 * @returns Property value or undefined if not found
 */
function getNestedProperty(obj, path) {
    return path.split('.').reduce((current, key) => current === null || current === void 0 ? void 0 : current[key], obj);
}
/**
 * Evaluate a simple boolean condition
 *
 * Supports basic comparisons:
 * - "0.8 > 0.5" → true
 * - "10 < 5" → false
 * - "true" → true
 * - "false" → false
 *
 * @param conditionStr - Condition string to evaluate
 * @returns Boolean result
 */
function evaluateCondition(conditionStr) {
    const trimmed = conditionStr.trim();
    // Boolean literals
    if (trimmed === 'true')
        return true;
    if (trimmed === 'false')
        return false;
    // Comparison operators
    const comparisonRegex = /^(.+?)\s*([<>]=?|[!=]=)\s*(.+)$/;
    const match = trimmed.match(comparisonRegex);
    if (match) {
        const [, left, operator, right] = match;
        const leftNum = parseFloat(left.trim());
        const rightNum = parseFloat(right.trim());
        if (!isNaN(leftNum) && !isNaN(rightNum)) {
            switch (operator) {
                case '>': return leftNum > rightNum;
                case '>=': return leftNum >= rightNum;
                case '<': return leftNum < rightNum;
                case '<=': return leftNum <= rightNum;
                case '==': return leftNum === rightNum;
                case '!=': return leftNum !== rightNum;
            }
        }
    }
    // Default: treat non-empty string as true
    return trimmed.length > 0 && trimmed !== '0';
}
/**
 * JSON operation: Bidirectional JSON conversion
 *
 * - String input → Parse to object/array
 * - Object/array input → Stringify to JSON string
 *
 * Examples:
 * inputData: '{"confidence": 0.9}' → { confidence: 0.9 }
 * inputData: { confidence: 0.9 } → '{"confidence":0.9}'
 *
 * @param config - Transform step configuration
 * @param inputData - JSON string or object/array
 * @returns Parsed object or stringified JSON
 */
function executeParseJsonOperation(config, inputData) {
    // Bidirectional: detect input type and convert accordingly
    if (typeof inputData === 'string') {
        // String → Parse to object/array
        // Try direct parse first (fast path for clean JSON)
        try {
            return JSON.parse(inputData.trim());
        }
        catch (directError) {
            // Direct parse failed - use robust extraction to handle noisy LLM output
            const extracted = (0, json_extractor_1.extractJSON)(inputData);
            if (extracted) {
                if (DEBUG)
                    console.log('[TransformExecutor] Extracted JSON from noisy LLM response');
                return extracted;
            }
            // Extraction failed - provide helpful error with preview
            const preview = inputData.substring(0, 300);
            throw new Error(`Failed to parse JSON: ${directError instanceof Error ? directError.message : String(directError)}\n` +
                `Preview: ${preview}${inputData.length > 300 ? '...' : ''}`);
        }
    }
    else if (typeof inputData === 'object' && inputData !== null) {
        // Object/array → Stringify to JSON
        try {
            return JSON.stringify(inputData);
        }
        catch (error) {
            throw new Error(`Failed to stringify to JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    else {
        // Primitives (number, boolean, null) → stringify directly
        return JSON.stringify(inputData);
    }
}
/**
 * Set operation: Set value directly from JavaScript expression evaluation
 *
 * Supports complex expressions with array indexing, object access, logical operators
 * Example:
 * value: "{{state.executionPlan.steps[state.currentStepIndex || 0]}}"
 * result: {type: "search", searchQuery: "..."}
 *
 * @param config - Transform step configuration with value expression
 * @param state - Current graph state for evaluation
 * @returns Evaluated value
 */
function executeSetOperation(config, state) {
    if (config.value === undefined) {
        throw new Error('Set operation requires value expression');
    }
    if (DEBUG)
        console.log('[SetOperation] Processing value:', config.value);
    // Delegate entirely to resolveValue — it handles primitives, pure expressions,
    // and mixed strings with type preservation.
    try {
        const result = (0, templateRenderer_1.resolveValue)(config.value, state);
        if (DEBUG)
            console.log('[SetOperation] Result type:', typeof result);
        return result;
    }
    catch (error) {
        console.error('[SetOperation] Evaluation failed:', error);
        throw new Error(`Failed to evaluate set value: ${config.value} - ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Append operation: Append value to array
 *
 * Example:
 * inputData: ["a", "b"]
 * value: "c"
 * result: ["a", "b", "c"]
 *
 * If inputData is undefined, creates new array: [value]
 *
 * @param config - Transform step configuration
 * @param inputData - Array to append to (or undefined)
 * @param state - Current graph state (for template rendering in value)
 * @returns Array with appended value
 */
function executeAppendOperation(config, inputData, state) {
    if (!config.value) {
        throw new Error('Append operation requires value to append');
    }
    // If inputData is undefined, create new array
    const array = inputData === undefined ? [] : inputData;
    if (!Array.isArray(array)) {
        throw new Error('Append operation requires input to be an array or undefined');
    }
    // Check if condition is provided (optional)
    if (config.condition) {
        const conditionStr = (0, templateRenderer_1.renderTemplate)(config.condition, state);
        const shouldAppend = evaluateCondition(conditionStr);
        if (!shouldAppend) {
            // Condition is false, return array unchanged
            if (DEBUG)
                console.log('[TransformExecutor] Append condition false, skipping');
            return array;
        }
        if (DEBUG)
            console.log('[TransformExecutor] Append condition true, appending');
    }
    // Render value if it contains template syntax
    let valueToAppend = config.value;
    if (typeof config.value === 'string' && config.value.includes('{{')) {
        // Support both {{field}} and {{state.field}} formats
        const template = config.value.includes('{{state.')
            ? config.value
            : config.value.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, '{{state.$1}}');
        valueToAppend = (0, templateRenderer_1.renderTemplate)(template, state);
    }
    else if (typeof config.value === 'object' && config.value !== null) {
        // For objects, recursively render any string properties that contain templates
        valueToAppend = renderObjectTemplates(config.value, state);
    }
    return [...array, valueToAppend];
}
/**
 * Recursively render templates in object properties
 */
function renderObjectTemplates(obj, state) {
    if (Array.isArray(obj)) {
        return obj.map((item) => renderObjectTemplates(item, state));
    }
    if (typeof obj === 'object' && obj !== null) {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string' && value.includes('{{')) {
                result[key] = (0, templateRenderer_1.renderTemplate)(value, state);
            }
            else if (typeof value === 'object') {
                result[key] = renderObjectTemplates(value, state);
            }
            else {
                result[key] = value;
            }
        }
        return result;
    }
    return obj;
}
/**
 * Concat operation: Concatenate two arrays
 *
 * Example:
 * inputData: ["a", "b"]
 * value: "otherArrayField" (field name in state)
 * state.otherArrayField: ["c", "d"]
 * result: ["a", "b", "c", "d"]
 *
 * @param config - Transform step configuration
 * @param inputData - First array
 * @param state - Current graph state (to lookup second array)
 * @returns Concatenated array
 */
function executeConcatOperation(config, inputData, state) {
    // fallbackToConcat: if either array is missing, use the one that exists (or empty array if both missing)
    const fallbackToConcat = config.fallbackToConcat;
    const fallbackToInput = config.fallbackToInput;
    // Support both 'value' and 'concatWith' field names
    const secondArrayField = config.value || config.concatWith;
    if (!secondArrayField) {
        throw new Error('Concat operation requires value or concatWith (second array field name)');
    }
    // Get second array from state (handles nested paths)
    let secondArray = getNestedProperty(state, secondArrayField);
    // Fallback: try data. prefix if not found (migration support)
    if (secondArray === undefined && !secondArrayField.startsWith('data.') && !secondArrayField.startsWith('state.')) {
        const dataPath = `data.${secondArrayField}`;
        const dataValue = getNestedProperty(state, dataPath);
        if (Array.isArray(dataValue)) {
            if (DEBUG)
                console.log(`[ConcatOperation] Using data. prefix for '${secondArrayField}'`);
            secondArray = dataValue;
        }
    }
    const inputIsArray = Array.isArray(inputData);
    const secondIsArray = Array.isArray(secondArray);
    if (DEBUG)
        console.log('[ConcatOperation] Concatenating arrays:', {
            inputLength: inputIsArray ? inputData.length : 'N/A',
            secondArrayLength: secondIsArray ? secondArray.length : 'N/A',
        });
    // With fallbackToConcat: gracefully handle missing arrays
    if (fallbackToConcat) {
        let result;
        if (inputIsArray && secondIsArray) {
            result = [...inputData, ...secondArray];
        }
        else if (inputIsArray) {
            // Only input exists, use it
            result = [...inputData];
        }
        else if (secondIsArray) {
            // Only second array exists, use it
            result = [...secondArray];
        }
        else {
            // Neither exists, return empty array
            result = [];
        }
        console.log('[ConcatOperation] Returning result with', result.length, 'items');
        return result;
    }
    // Handle fallback scenarios (strict mode)
    if (inputData === undefined || !inputIsArray) {
        if (secondIsArray) {
            if (DEBUG)
                console.log('[ConcatOperation] Using fallback: only secondArray');
            return [...secondArray];
        }
        throw new Error('Concat operation requires input to be an array');
    }
    if (!secondIsArray) {
        if (fallbackToInput) {
            if (DEBUG)
                console.log('[ConcatOperation] Using fallback: only inputData');
            return [...inputData];
        }
        throw new Error(`Concat operation requires second array at ${secondArrayField} to be an array`);
    }
    // Both arrays exist, concat them
    if (DEBUG) {
        console.log('[ConcatOperation] Concatenating:', inputData.length, '+', secondArray.length);
    }
    return [...inputData, ...secondArray];
}
/**
 * Build-messages operation: Build LLM message array with role/content pairs
 *
 * Two modes:
 * 1. If useExistingField is set, return that field directly (pre-built messages)
 * 2. Otherwise, build from messages array, rendering templates
 *
 * Example:
 * messages: [
 *   { role: 'system', content: '{{state.systemMessage}}' },
 *   { role: 'user', content: '{{state.query}}' }
 * ]
 * state.systemMessage: "You are a helpful assistant"
 * state.query: "What is AI?"
 * result: [
 *   { role: 'system', content: 'You are a helpful assistant' },
 *   { role: 'user', content: 'What is AI?' }
 * ]
 *
 * @param config - Transform step configuration
 * @param state - Current graph state
 * @returns Array of message objects with role and content
 */
function executeBuildMessagesOperation(config, state) {
    // Mode 1: Use existing field if specified
    if (config.useExistingField) {
        const existingMessages = getNestedProperty(state, config.useExistingField);
        if (existingMessages !== undefined) {
            if (!Array.isArray(existingMessages)) {
                throw new Error(`useExistingField ${config.useExistingField} is not an array`);
            }
            return existingMessages;
        }
        // If useExistingField is set but field doesn't exist, fall through to build from messages
    }
    // Mode 2: Build from messages array
    if (!config.messages || config.messages.length === 0) {
        throw new Error('build-messages operation requires either messages array or useExistingField');
    }
    const builtMessages = [];
    for (const message of config.messages) {
        if (!message.role || !message.content) {
            throw new Error('Each message must have role and content properties');
        }
        // Render content template
        const renderedContent = (0, templateRenderer_1.renderTemplate)(message.content, state);
        builtMessages.push({
            role: message.role,
            content: renderedContent,
        });
    }
    return builtMessages;
}
/**
 * Set Global State Operation
 *
 * Sets a value in persistent global state that can be accessed across workflows.
 *
 * Config:
 * - namespace: Target namespace (required)
 * - key: Key to set (required, or use inputField value)
 * - inputField: Source field containing the value to set
 * - value: Static value to set (if inputField not provided)
 * - ttlSeconds: Optional TTL for auto-expiration
 * - description: Optional description
 *
 * Example:
 * {
 *   operation: 'set-global',
 *   namespace: 'user-settings',
 *   key: 'theme',
 *   inputField: 'data.selectedTheme'
 * }
 */
function executeSetGlobalOperation(config, inputData, state) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        if (!config.namespace) {
            throw new Error('set-global operation requires namespace');
        }
        if (!config.key) {
            throw new Error('set-global operation requires key');
        }
        // Resolve templates in namespace and key (type-preserving)
        const namespace = (0, templateRenderer_1.resolveValue)(config.namespace, state);
        const key = (0, templateRenderer_1.resolveValue)(config.key, state);
        // Get value from inputData, config.value, or resolve as template (type-preserving)
        let valueToSet = inputData;
        if (valueToSet === undefined && config.value !== undefined) {
            valueToSet = (0, templateRenderer_1.resolveValue)(config.value, state);
        }
        if (valueToSet === undefined) {
            console.warn(`[SetGlobalOperation] No value to set for ${namespace}.${key}`);
            return { _globalStateSet: false };
        }
        const client = getGlobalStateClient({
            userId: ((_a = state.data) === null || _a === void 0 ? void 0 : _a.userId) || state.userId,
            workflowId: ((_b = state.data) === null || _b === void 0 ? void 0 : _b.graphId) || state.graphId,
        });
        const success = yield client.setValue(namespace, key, valueToSet, {
            description: config.description,
            ttlSeconds: config.ttlSeconds,
        });
        if (DEBUG)
            console.log(`[SetGlobalOperation] Set ${namespace}.${key}`);
        // Return metadata about the operation
        return {
            _globalStateSet: success,
            _globalStateKey: `${namespace}.${key}`,
        };
    });
}
/**
 * Get Global State Operation
 *
 * Gets a value from persistent global state.
 *
 * Config:
 * - namespace: Source namespace (required)
 * - key: Key to get (required)
 * - outputField: Where to store the retrieved value
 *
 * Example:
 * {
 *   operation: 'get-global',
 *   namespace: 'user-settings',
 *   key: 'theme',
 *   outputField: 'data.userTheme'
 * }
 */
function executeGetGlobalOperation(config, state) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        if (!config.namespace) {
            throw new Error('get-global operation requires namespace');
        }
        if (!config.key) {
            throw new Error('get-global operation requires key');
        }
        // Resolve templates in namespace and key (type-preserving)
        const namespace = (0, templateRenderer_1.resolveValue)(config.namespace, state);
        const key = (0, templateRenderer_1.resolveValue)(config.key, state);
        const client = getGlobalStateClient({
            userId: ((_a = state.data) === null || _a === void 0 ? void 0 : _a.userId) || state.userId,
            workflowId: ((_b = state.data) === null || _b === void 0 ? void 0 : _b.graphId) || state.graphId,
        });
        const value = yield client.getValue(namespace, key);
        if (DEBUG)
            console.log(`[GetGlobalOperation] Got ${namespace}.${key}`);
        // Return the value to be stored in outputField
        return value;
    });
}
/**
 * Increment operation: Add to a number value
 *
 * Example:
 * inputData: 5
 * value: 2 (optional, defaults to 1)
 * result: 7
 *
 * @param config - Transform step configuration
 * @param inputData - Current number value (or undefined to start from 0)
 * @param state - Current graph state
 * @returns Incremented number
 */
function executeIncrementOperation(config, inputData, state) {
    // Get the amount to increment by (default 1)
    let incrementBy = 1;
    if (config.value !== undefined) {
        const resolved = (0, templateRenderer_1.resolveValue)(config.value, state);
        incrementBy = Number(resolved) || 1;
    }
    // Get current value (default 0)
    const currentValue = typeof inputData === 'number' ? inputData : 0;
    if (DEBUG)
        console.log(`[IncrementOperation] ${currentValue} + ${incrementBy}`);
    return currentValue + incrementBy;
}
/**
 * Decrement operation: Subtract from a number value
 *
 * Example:
 * inputData: 5
 * value: 2 (optional, defaults to 1)
 * result: 3
 *
 * @param config - Transform step configuration
 * @param inputData - Current number value (or undefined to start from 0)
 * @param state - Current graph state
 * @returns Decremented number
 */
function executeDecrementOperation(config, inputData, state) {
    // Get the amount to decrement by (default 1)
    let decrementBy = 1;
    if (config.value !== undefined) {
        const resolved = (0, templateRenderer_1.resolveValue)(config.value, state);
        decrementBy = Number(resolved) || 1;
    }
    // Get current value (default 0)
    const currentValue = typeof inputData === 'number' ? inputData : 0;
    if (DEBUG)
        console.log(`[DecrementOperation] ${currentValue} - ${decrementBy}`);
    return currentValue - decrementBy;
}
