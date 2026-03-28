/**
 * Transform Step Executor
 *
 * Executes data transformations on arrays and objects.
 * Supports map, filter, and select operations with template rendering.
 */
import { renderTemplate } from '../templateRenderer';
import { extractJSON } from '../../../utils/json-extractor';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getGlobalStateClient } = require('../../../globalState') as { getGlobalStateClient: (opts?: any) => any };
import type { TransformStepConfig } from '../types';

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
export async function executeTransform(config: TransformStepConfig, state: any): Promise<Partial<any>> {
    console.log('[TransformExecutor] ====== STARTING TRANSFORM ======');
    console.log('[TransformExecutor] Operation:', config.operation);
    console.log('[TransformExecutor] InputField:', config.inputField);
    console.log('[TransformExecutor] OutputField:', config.outputField);
    try {
        // build-messages doesn't require inputField
        let inputData: any = undefined;
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
                    userId: state.data?.userId || state.userId,
                    workflowId: state.data?.graphId || state.graphId,
                });
                inputData = await client.getValue(namespace, key);
            } else {
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
        const allowUndefinedInput =
            config.operation === 'append' ||
            config.operation === 'build-messages' ||
            config.operation === 'set' ||
            config.operation === 'set-global' ||
            config.operation === 'get-global' ||
            config.operation === 'increment' ||
            config.operation === 'decrement' ||
            (config.operation === 'concat' && (config as any).fallbackToConcat);

        if (inputData === undefined && !allowUndefinedInput) {
            throw new Error(`Input field not found in state: ${config.inputField}`);
        }

        // Execute operation
        let result: any;
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
                result = await executeSetGlobalOperation(config, inputData, state);
                break;
            case 'get-global':
                result = await executeGetGlobalOperation(config, state);
                break;
            case 'increment':
                result = executeIncrementOperation(config, inputData, state);
                break;
            case 'decrement':
                result = executeDecrementOperation(config, inputData, state);
                break;
            default:
                throw new Error(`Unknown transform operation: ${(config as any).operation}`);
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
                userId: state.data?.userId || state.userId,
                workflowId: state.data?.graphId || state.graphId,
            });
            const success = await client.setValue(namespace, key, result, {
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
    } catch (error) {
        throw new Error(`Transform step failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Map operation: Apply transform template to each element
 *
 * Example:
 * inputData: [{ url: "https://..." }, { url: "https://..." }]
 * transform: "{{item.url}}"
 * result: ["https://...", "https://..."]
 */
function executeMapOperation(config: TransformStepConfig, inputData: any, state: any): any[] {
    if (!Array.isArray(inputData)) {
        throw new Error('Map operation requires input to be an array');
    }
    if (!config.transform) {
        throw new Error('Map operation requires transform template');
    }
    return inputData.map((item: any, index: number) => {
        // Create augmented state with item context
        // renderTemplate extracts the path after "state.", so we add item and index at root
        const itemState = { ...state, item, index };
        // Render transform template with item context
        // Template can use {{state.item.xxx}} or {{state.index}}
        return renderTemplate(config.transform!, itemState);
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
function executeFilterOperation(config: TransformStepConfig, inputData: any, state: any): any[] {
    if (!Array.isArray(inputData)) {
        throw new Error('Filter operation requires input to be an array');
    }
    if (!config.filterCondition) {
        throw new Error('Filter operation requires filterCondition');
    }
    return inputData.filter((item: any, index: number) => {
        // Create augmented state with item context
        // renderTemplate extracts the path after "state.", so we add item and index at root
        const itemState = { ...state, item, index };
        // Render condition template
        // Template can use {{state.item.xxx}} or {{state.index}}
        const conditionStr = renderTemplate(config.filterCondition!, itemState);
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
function executeSelectOperation(config: TransformStepConfig, inputData: any): any {
    if (!config.transform) {
        throw new Error('Select operation requires transform (property path)');
    }
    const propertyPath = config.transform;
    // If input is array, extract property from each element
    if (Array.isArray(inputData)) {
        return inputData.map((item: any) => getNestedProperty(item, propertyPath));
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
function getNestedProperty(obj: any, path: string): any {
    return path.split('.').reduce((current: any, key: string) => current?.[key], obj);
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
function evaluateCondition(conditionStr: string): boolean {
    const trimmed = conditionStr.trim();
    // Boolean literals
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
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
function executeParseJsonOperation(config: TransformStepConfig, inputData: any): any {
    // Bidirectional: detect input type and convert accordingly
    if (typeof inputData === 'string') {
        // String → Parse to object/array
        // Try direct parse first (fast path for clean JSON)
        try {
            return JSON.parse(inputData.trim());
        } catch (directError) {
            // Direct parse failed - use robust extraction to handle noisy LLM output
            const extracted = extractJSON(inputData);
            if (extracted) {
                if (DEBUG)
                    console.log('[TransformExecutor] Extracted JSON from noisy LLM response');
                return extracted;
            }
            // Extraction failed - provide helpful error with preview
            const preview = inputData.substring(0, 300);
            throw new Error(
                `Failed to parse JSON: ${directError instanceof Error ? directError.message : String(directError)}\n` +
                `Preview: ${preview}${inputData.length > 300 ? '...' : ''}`
            );
        }
    } else if (typeof inputData === 'object' && inputData !== null) {
        // Object/array → Stringify to JSON
        try {
            return JSON.stringify(inputData);
        } catch (error) {
            throw new Error(`Failed to stringify to JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else {
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
function executeSetOperation(config: TransformStepConfig, state: any): any {
    if (config.value === undefined) {
        throw new Error('Set operation requires value expression');
    }
    // If value is a boolean, number, or null, return it directly without string conversion
    if (typeof config.value === 'boolean' || typeof config.value === 'number' || config.value === null) {
        if (DEBUG)
            console.log('[SetOperation] Returning primitive value:', config.value);
        return config.value;
    }
    const valueStr = String(config.value);
    if (DEBUG)
        console.log('[SetOperation] Processing value:', valueStr);
    // If it's a template expression, evaluate it as JavaScript
    if (valueStr.startsWith('{{') && valueStr.endsWith('}}')) {
        const expression = valueStr.slice(2, -2).trim(); // Remove '{{' and '}}', trim to avoid ASI after 'return'
        if (DEBUG)
            console.log('[SetOperation] Evaluating expression:', expression);
        try {
            // Create a function that evaluates the expression with state in scope
            // The expression can be simple property access or complex JavaScript
            // Note: .trim() above prevents ASI from inserting semicolon after 'return\n'
            const evalFunc = new Function('state', `return (${expression})`);
            const result = evalFunc(state);
            if (DEBUG)
                console.log('[SetOperation] Evaluation result:', typeof result);
            return result;
        } catch (error) {
            console.error('[SetOperation] Evaluation failed:', error);
            throw new Error(`Failed to evaluate expression: ${expression} - ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // Otherwise try template rendering for simple substitutions
    if (DEBUG)
        console.log('[SetOperation] Using template rendering');
    return renderTemplate(valueStr, state);
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
function executeAppendOperation(config: TransformStepConfig, inputData: any, state: any): any[] {
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
        const conditionStr = renderTemplate(config.condition, state);
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
    let valueToAppend: any = config.value;
    if (typeof config.value === 'string' && config.value.includes('{{')) {
        // Support both {{field}} and {{state.field}} formats
        const template = config.value.includes('{{state.')
            ? config.value
            : config.value.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, '{{state.$1}}');
        valueToAppend = renderTemplate(template, state);
    } else if (typeof config.value === 'object' && config.value !== null) {
        // For objects, recursively render any string properties that contain templates
        valueToAppend = renderObjectTemplates(config.value, state);
    }
    return [...array, valueToAppend];
}

/**
 * Recursively render templates in object properties
 */
function renderObjectTemplates(obj: any, state: any): any {
    if (Array.isArray(obj)) {
        return obj.map((item: any) => renderObjectTemplates(item, state));
    }
    if (typeof obj === 'object' && obj !== null) {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string' && value.includes('{{')) {
                result[key] = renderTemplate(value, state);
            } else if (typeof value === 'object') {
                result[key] = renderObjectTemplates(value, state);
            } else {
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
function executeConcatOperation(config: TransformStepConfig, inputData: any, state: any): any[] {
    // fallbackToConcat: if either array is missing, use the one that exists (or empty array if both missing)
    const fallbackToConcat = (config as any).fallbackToConcat;
    const fallbackToInput = (config as any).fallbackToInput;
    // Support both 'value' and 'concatWith' field names
    const secondArrayField = config.value || (config as any).concatWith;
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
        let result: any[];
        if (inputIsArray && secondIsArray) {
            result = [...inputData, ...secondArray];
        } else if (inputIsArray) {
            // Only input exists, use it
            result = [...inputData];
        } else if (secondIsArray) {
            // Only second array exists, use it
            result = [...secondArray];
        } else {
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
function executeBuildMessagesOperation(config: TransformStepConfig, state: any): Array<{ role: string; content: string }> {
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
    const builtMessages: Array<{ role: string; content: string }> = [];
    for (const message of config.messages) {
        if (!message.role || !message.content) {
            throw new Error('Each message must have role and content properties');
        }
        // Render content template
        const renderedContent = renderTemplate(message.content, state);
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
async function executeSetGlobalOperation(config: TransformStepConfig, inputData: any, state: any): Promise<any> {
    if (!config.namespace) {
        throw new Error('set-global operation requires namespace');
    }
    if (!config.key) {
        throw new Error('set-global operation requires key');
    }
    // Render templates in namespace and key
    const namespace = typeof config.namespace === 'string' ? renderTemplate(config.namespace, state) : config.namespace;
    const key = typeof config.key === 'string' ? renderTemplate(config.key, state) : config.key;
    // Get value from inputData, config.value, or render as template
    let valueToSet: any = inputData;
    if (valueToSet === undefined && config.value !== undefined) {
        valueToSet = typeof config.value === 'string'
            ? renderTemplate(config.value, state)
            : config.value;
    }
    if (valueToSet === undefined) {
        console.warn(`[SetGlobalOperation] No value to set for ${namespace}.${key}`);
        return { _globalStateSet: false };
    }
    const client = getGlobalStateClient({
        userId: state.data?.userId || state.userId,
        workflowId: state.data?.graphId || state.graphId,
    });
    const success = await client.setValue(namespace, key, valueToSet, {
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
async function executeGetGlobalOperation(config: TransformStepConfig, state: any): Promise<any> {
    if (!config.namespace) {
        throw new Error('get-global operation requires namespace');
    }
    if (!config.key) {
        throw new Error('get-global operation requires key');
    }
    // Render templates in namespace and key
    const namespace = typeof config.namespace === 'string' ? renderTemplate(config.namespace, state) : config.namespace;
    const key = typeof config.key === 'string' ? renderTemplate(config.key, state) : config.key;
    const client = getGlobalStateClient({
        userId: state.data?.userId || state.userId,
        workflowId: state.data?.graphId || state.graphId,
    });
    const value = await client.getValue(namespace, key);
    if (DEBUG)
        console.log(`[GetGlobalOperation] Got ${namespace}.${key}`);
    // Return the value to be stored in outputField
    return value;
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
function executeIncrementOperation(config: TransformStepConfig, inputData: any, state: any): number {
    // Get the amount to increment by (default 1)
    let incrementBy = 1;
    if (config.value !== undefined) {
        if (typeof config.value === 'number') {
            incrementBy = config.value;
        } else if (typeof config.value === 'string') {
            // Try to parse or render template
            const rendered = config.value.includes('{{')
                ? renderTemplate(config.value, state)
                : config.value;
            incrementBy = Number(rendered) || 1;
        }
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
function executeDecrementOperation(config: TransformStepConfig, inputData: any, state: any): number {
    // Get the amount to decrement by (default 1)
    let decrementBy = 1;
    if (config.value !== undefined) {
        if (typeof config.value === 'number') {
            decrementBy = config.value;
        } else if (typeof config.value === 'string') {
            // Try to parse or render template
            const rendered = config.value.includes('{{')
                ? renderTemplate(config.value, state)
                : config.value;
            decrementBy = Number(rendered) || 1;
        }
    }
    // Get current value (default 0)
    const currentValue = typeof inputData === 'number' ? inputData : 0;
    if (DEBUG)
        console.log(`[DecrementOperation] ${currentValue} - ${decrementBy}`);
    return currentValue - decrementBy;
}
