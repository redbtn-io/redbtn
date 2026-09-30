/**
 * Transform Step Executor
 *
 * Executes data transformations on arrays and objects.
 * Supports map, filter, and select operations with template rendering.
 */
import { renderTemplate, resolveValue } from '../templateRenderer';
import { extractJSON } from '../../../utils/json-extractor';
// `../../../globalState` is a plain re-export of the GlobalStateClient class —
// no module-level side effects, so a static import is safe. It used to be a
// top-level `require()`, which Node cannot resolve from src/ (the module is
// TS-only), making this executor un-importable outside a built dist/ tree —
// that is why the transform persistence path had no test coverage.
import { getGlobalStateClient } from '../../../globalState';
import type { TransformStepConfig } from '../types';
import { executeBuildMessagesOperation as buildMessagesOpExternal } from './buildMessagesOperation';
import { getRunPublisher } from '../../../run/contextLookup';

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
        // Atomic global counter. `increment` / `decrement` whose input AND
        // output are the same `globalState.<namespace>.<key>` used to be a
        // read (through the client's 5s cache) + a whole-value write: parallel
        // branches or concurrent runs bumping one counter lost updates. Route
        // it to the webapp's single-update atomic increment instead, keeping
        // the step's historical semantics (missing or non-number value counts
        // from 0; `value` resolving to 0/NaN means 1). Falls through to the
        // legacy path only when the webapp predates the atomic endpoint.
        const atomicCounter = sameGlobalStateKey(config.inputField, config.outputField);
        if (atomicCounter && (config.operation === 'increment' || config.operation === 'decrement')) {
            const amount = resolveStepAmount(config, state);
            const delta = config.operation === 'increment' ? amount : -amount;
            const client = getGlobalStateClient({
                userId: state.data?.userId || state.userId,
                workflowId: state.data?.graphId || state.graphId,
            });
            const res = await client.increment(atomicCounter.namespace, atomicCounter.key, delta, {
                initial: 0,
                onNonNumber: 'reset',
                ttlSeconds: config.ttlSeconds,
                description: config.description,
            });
            if (res.supported) {
                if (!res.ok) {
                    console.warn(`[TransformExecutor] Atomic ${config.operation} of ${atomicCounter.namespace}.${atomicCounter.key} failed: ${res.error}`);
                }
                return {
                    _globalStateSet: res.ok,
                    _globalStateKey: `${atomicCounter.namespace}.${atomicCounter.key}`,
                };
            }
            console.warn('[TransformExecutor] Webapp has no atomic state endpoint — falling back to read-modify-write increment');
        }

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

        // Run-shared State Detection:
        // If outputField starts with `shared.`, route to the run-scoped
        // Redis hash backing `state.shared`. Designed for parallel-
        // branch coordination inside a single run — see
        // lib/run/run-shared-state.ts for the full picture.
        // Example: outputField='shared.thinking' → HSET on RunKeys.shared.
        if (config.outputField && config.outputField.startsWith('shared.')) {
            const key = config.outputField.slice('shared.'.length);
            if (!key) {
                throw new Error(`Invalid shared path: ${config.outputField}. Expected format: shared.<key>`);
            }
            const runPublisher = getRunPublisher(state);
            if (!runPublisher) {
                // Engine paths that don't have a RunPublisher attached
                // (rare) shouldn't crash. Warn and fall through to a
                // normal local-state write so behavior degrades cleanly.
                console.warn(`[TransformExecutor] No runPublisher on state — falling back to local set for ${config.outputField}`);
                return { [config.outputField]: result };
            }
            await runPublisher.setSharedField(key, result);
            if (DEBUG) console.log(`[TransformExecutor] Wrote shared.${key} via runPublisher`);
            return {
                _sharedStateSet: true,
                _sharedStateKey: key,
            };
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

        // Auto-mirror in parallel context. When the wrapping graph node
        // is inside a `parallel:` block (compiler stamps `_parallelContext`
        // on state — see graphs/compiler.ts + graphs/parallel-context.ts),
        // dual-write the outputField to the run-scoped auto-state hash.
        // Peer branches' next step boundary will overlay the value back
        // onto their local state via universalNode/loopExecutor hydration,
        // so they see the write WITHOUT the config needing a `shared.`
        // prefix. No-op outside parallel blocks.
        //
        // Skipped when outputField already starts with `shared.` /
        // `globalState.` — those have explicit storage layers handled
        // above and dual-writing would just thrash Redis.
        const autoPublisher = getRunPublisher(state);
        if (
            config.outputField &&
            state._parallelContext &&
            autoPublisher &&
            !config.outputField.startsWith('shared.') &&
            !config.outputField.startsWith('globalState.')
        ) {
            try {
                await autoPublisher.setAutoStateField(config.outputField, result);
                if (DEBUG) console.log(`[TransformExecutor] Auto-mirrored ${config.outputField} → autoState`);
            } catch (err) {
                console.warn(`[TransformExecutor] Auto-mirror failed for ${config.outputField}:`, err);
            }
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
    if (DEBUG)
        console.log('[SetOperation] Processing value:', config.value);
    // Delegate entirely to resolveValue — it handles primitives, pure expressions,
    // and mixed strings with type preservation. A set operation mutates graph
    // state, so it must fail closed for malformed pure expressions. Returning the
    // original `{{ ... }}` source here turns a syntax error into apparently valid
    // state and lets downstream tools execute or display the raw template.
    try {
        const result = resolveValue(config.value, state, { throwOnError: true });
        if (DEBUG)
            console.log('[SetOperation] Result type:', typeof result);
        return result;
    } catch (error) {
        // resolveValue already logged the underlying evaluation error; re-raise
        // with the target field and the offending template so the run's error
        // says which step broke and what source failed to compile.
        const target = config.outputField || 'unnamed output';
        throw new Error(
            `Failed to evaluate set template for ${target}: ` +
            `${error instanceof Error ? error.message : String(error)} ` +
            `(template: ${summarizeTemplate(config.value)})`,
        );
    }
}

/**
 * Collapse a template to a single-line, bounded snippet for error messages.
 * Set templates are frequently multi-line IIFEs — the raw source would bury
 * the actual error in a run log.
 */
function summarizeTemplate(value: any): string {
    const source = typeof value === 'string' ? value : JSON.stringify(value);
    const singleLine = String(source).replace(/\s+/g, ' ').trim();
    return singleLine.length > 160 ? `${singleLine.slice(0, 160)}…` : singleLine;
}

/**
 * Resolve a template that feeds a state-mutating global operation.
 *
 * Same fail-closed reasoning as `executeSetOperation`: `set-global` writes to
 * persistent, cross-run storage, so a malformed template must abort the step
 * rather than silently addressing the wrong slot (namespace/key) or storing the
 * raw `{{ ... }}` source as if it were a rendered value.
 */
function resolveMutatingTemplate(value: any, state: any, field: string): any {
    try {
        return resolveValue(value, state, { throwOnError: true });
    } catch (error) {
        throw new Error(
            `Failed to evaluate set-global ${field} template: ` +
            `${error instanceof Error ? error.message : String(error)} ` +
            `(template: ${summarizeTemplate(value)})`,
        );
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
 * Unwrap a tool-result message envelope into its message array.
 *
 * `get_context_history(format:'llm')` (and other native tools that follow the
 * MCP convention of returning a JSON text payload) produce
 * `{ messages: [...], metadata: {...} }`, which the tool executor JSON-parses
 * into state. Graphs that point a concat at the tool's `outputField` (the
 * system `context` node does exactly this) previously saw a non-array and,
 * with `fallbackToConcat`, silently dropped the whole history. A real array is
 * never touched; only a plain (non-array) object whose `messages` field is an
 * array is unwrapped.
 */
export function unwrapMessageEnvelope(value: any): { value: any; unwrapped: boolean } {
    if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Array.isArray((value as any).messages)
    ) {
        return { value: (value as any).messages, unwrapped: true };
    }
    return { value, unwrapped: false };
}

function isChatMessage(m: any): boolean {
    return m !== null && typeof m === 'object' && typeof m.role === 'string' && 'content' in m;
}

/**
 * Two chat messages are "the same turn" when they carry the same id, or the
 * same role and content. get_context_history prefixes a multi-party user turn
 * as `${name}: ${content}` (and sets `name`), so that prefixed form also
 * matches the raw content the run input carries.
 */
function sameChatMessage(a: any, b: any): boolean {
    if (!isChatMessage(a) || !isChatMessage(b)) return false;
    if (a.id !== undefined && b.id !== undefined) return a.id === b.id;
    if (a.role !== b.role) return false;
    if (typeof a.content !== 'string' || typeof b.content !== 'string') {
        return JSON.stringify(a.content) === JSON.stringify(b.content);
    }
    const ac = a.content.trim();
    const bc = b.content.trim();
    if (ac === bc) return true;
    if (typeof a.name === 'string' && a.name && ac === `${a.name}: ${bc}`) return true;
    if (typeof b.name === 'string' && b.name && bc === `${b.name}: ${ac}`) return true;
    return false;
}

/**
 * Join two message arrays, dropping the overlap where the tail of `first`
 * repeats the head of `second`.
 *
 * Why: the conversation dispatch path (web chat, terminal/CLI sessions)
 * persists the triggering user message BEFORE the run starts, so the history
 * get_context_history loads already ends with the current turn, while
 * `data.messages` (seeded from `input.message`) starts with it. A plain concat
 * would hand the model the current message twice. Only a contiguous boundary
 * overlap is removed, so an earlier turn that happens to repeat text is never
 * touched, and a history that does NOT yet contain the current turn
 * (voice/stream subgraph calls) is joined unchanged.
 */
export function concatMessagesDeduped(first: any[], second: any[]): any[] {
    const max = Math.min(first.length, second.length);
    for (let k = max; k > 0; k--) {
        let match = true;
        for (let i = 0; i < k; i++) {
            if (!sameChatMessage(first[first.length - k + i], second[i])) {
                match = false;
                break;
            }
        }
        if (match) {
            return [...first.slice(0, first.length - k), ...second];
        }
    }
    return [...first, ...second];
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
 * Either side may also be a tool-result envelope `{ messages: [...] }`
 * (get_context_history llm format); it is unwrapped to its array. When an
 * envelope was unwrapped, or `dedupeMessages: true` is set on the step, the
 * join drops a duplicated boundary turn (see concatMessagesDeduped). Two real
 * arrays without `dedupeMessages` concatenate exactly as before.
 *
 * @param config - Transform step configuration
 * @param rawInputData - First array (or {messages} envelope)
 * @param state - Current graph state (to lookup second array)
 * @returns Concatenated array
 */
function executeConcatOperation(config: TransformStepConfig, rawInputData: any, state: any): any[] {
    // fallbackToConcat: if either array is missing, use the one that exists (or empty array if both missing)
    const fallbackToConcat = (config as any).fallbackToConcat;
    const fallbackToInput = (config as any).fallbackToInput;
    // Support both 'value' and 'concatWith' field names
    const secondArrayField = config.value || (config as any).concatWith;
    if (!secondArrayField) {
        throw new Error('Concat operation requires value or concatWith (second array field name)');
    }
    // Get second array from state (handles nested paths)
    let rawSecond = getNestedProperty(state, secondArrayField);
    // Fallback: try data. prefix if not found (migration support)
    if (rawSecond === undefined && !secondArrayField.startsWith('data.') && !secondArrayField.startsWith('state.')) {
        const dataPath = `data.${secondArrayField}`;
        const dataValue = getNestedProperty(state, dataPath);
        if (Array.isArray(dataValue) || unwrapMessageEnvelope(dataValue).unwrapped) {
            if (DEBUG)
                console.log(`[ConcatOperation] Using data. prefix for '${secondArrayField}'`);
            rawSecond = dataValue;
        }
    }
    const firstUnwrap = unwrapMessageEnvelope(rawInputData);
    const secondUnwrap = unwrapMessageEnvelope(rawSecond);
    const inputData = firstUnwrap.value;
    const secondArray = secondUnwrap.value;
    const dedupe = firstUnwrap.unwrapped || secondUnwrap.unwrapped || (config as any).dedupeMessages === true;
    if (firstUnwrap.unwrapped || secondUnwrap.unwrapped) {
        console.log('[ConcatOperation] Unwrapped {messages} envelope:', {
            input: firstUnwrap.unwrapped,
            concatWith: secondUnwrap.unwrapped,
        });
    }
    const join = (a: any[], b: any[]): any[] => (dedupe ? concatMessagesDeduped(a, b) : [...a, ...b]);
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
            result = join(inputData, secondArray);
        } else if (inputIsArray) {
            // Only input exists, use it
            result = [...inputData];
        } else if (secondIsArray) {
            // Only second array exists, use it
            if (inputData !== undefined && inputData !== null) {
                // A present-but-unusable input (e.g. a tool error string) is
                // dropped. Say so, so a lost history is never silent again.
                console.warn(`[ConcatOperation] Input ${config.inputField} is not an array (${typeof inputData}); using only ${secondArrayField}`);
            }
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
    return join(inputData, secondArray);
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
function executeBuildMessagesOperation(config: TransformStepConfig, state: any): Array<{ role: string; content: string | unknown[] }> {
    return buildMessagesOpExternal(config, state, { renderTemplate, getNestedProperty });
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
    // Resolve templates in namespace and key (type-preserving).
    // These address the storage slot, so a malformed template must not fall back
    // to the literal `{{ ... }}` source — that would write to a namespace/key
    // named after the template itself.
    const namespace = resolveMutatingTemplate(config.namespace, state, 'namespace');
    const key = resolveMutatingTemplate(config.key, state, 'key');
    // Get value from inputData, config.value, or resolve as template (type-preserving)
    let valueToSet: any = inputData;
    if (valueToSet === undefined && config.value !== undefined) {
        valueToSet = resolveMutatingTemplate(config.value, state, 'value');
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
    // Resolve templates in namespace and key (type-preserving)
    const namespace = resolveValue(config.namespace, state);
    const key = resolveValue(config.key, state);
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
 * Amount for increment / decrement: `config.value` resolved against state,
 * defaulting to 1 (and, historically, 0 / NaN also mean 1).
 */
function resolveStepAmount(config: TransformStepConfig, state: any): number {
    if (config.value === undefined) return 1;
    const resolved = resolveValue(config.value, state);
    return Number(resolved) || 1;
}

/**
 * When `inputField` and `outputField` both address the SAME whole global-state
 * key (`globalState.<namespace>.<key>`, exactly three segments), return it.
 * That is the read-modify-write shape an atomic server-side op can replace.
 */
export function sameGlobalStateKey(
    inputField: string | undefined,
    outputField: string | undefined,
): { namespace: string; key: string } | null {
    if (!inputField || !outputField || inputField !== outputField) return null;
    const parts = inputField.split('.');
    if (parts.length !== 3 || parts[0] !== 'globalState' || !parts[1] || !parts[2]) return null;
    return { namespace: parts[1], key: parts[2] };
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
    const incrementBy = resolveStepAmount(config, state);
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
    const decrementBy = resolveStepAmount(config, state);
    // Get current value (default 0)
    const currentValue = typeof inputData === 'number' ? inputData : 0;
    if (DEBUG)
        console.log(`[DecrementOperation] ${currentValue} - ${decrementBy}`);
    return currentValue - decrementBy;
}
