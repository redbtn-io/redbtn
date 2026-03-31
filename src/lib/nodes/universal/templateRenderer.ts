/**
 * Template Renderer
 *
 * Renders template variables in the format {{state.fieldName}} by substituting
 * them with actual values from the state object.
 *
 * Supports:
 * - State fields: {{state.query}}, {{state.user.name}}
 * - Parameters: {{parameters.temperature}}, {{parameters.model}}
 * - Global State: {{globalState.namespace.key}} (persisted across workflows)
 * - Multiple variables in same string
 * - Undefined variables are left as-is (not replaced)
 *
 * Examples:
 *
 * renderTemplate("Hello {{state.user.name}}", { user: { name: "Alice" } })
 * // Returns: "Hello Alice"
 *
 * renderTemplate("Temp: {{parameters.temperature}}", { parameters: { temperature: 0.7 } })
 * // Returns: "Temp: 0.7"
 *
 * renderTemplate("Search: {{state.query}}", { query: "TypeScript" })
 * // Returns: "Search: TypeScript"
 *
 * renderTemplate("Missing: {{state.unknown}}", {})
 * // Returns: "Missing: {{state.unknown}}" (variable not found, left as-is)
 *
 * // Global state (async):
 * await renderTemplateAsync("API Key: {{globalState.config.api_key}}", state)
 * // Returns: "API Key: sk-xxx..." (fetched from persistent storage)
 */

// Minimal interface for the GlobalStateClient methods used in this module.
// The full implementation lives in dist/lib/globalState/ (dist-only module).
interface IGlobalStateClient {
    resolveTemplatePath(path: string): Promise<any>;
    prefetch(namespace: string): Promise<void>;
}

// This import resolves from the dist/ directory at runtime — it is a
// hand-maintained module that has no source counterpart in src/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getGlobalStateClient } = require('../../globalState') as { getGlobalStateClient: (options?: Record<string, unknown>) => IGlobalStateClient };

/**
 * Render a template string by replacing {{state.field}} and {{parameters.field}} variables
 *
 * Supports nested property access via dot notation.
 *
 * @param template - Template string with {{state.field}} or {{parameters.field}} placeholders
 * @param state - State object containing values to substitute (includes parameters)
 * @returns Rendered string with variables replaced
 */
export function renderTemplate(template: string, state: any): string {
    // First, replace {{parameters.xxx}} patterns
    let result = template.replace(/\{\{parameters\.(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
        // Get value from state.parameters
        const value = getNestedProperty(state.parameters || {}, path);
        if (value !== undefined) {
            if (typeof value === 'object' && value !== null) {
                return JSON.stringify(value);
            }
            return String(value);
        } else {
            console.warn(`[TemplateRenderer] Parameter not found: parameters.${path}`);
            return match; // Return original {{parameters.xxx}} if not found
        }
    });
    // Then, replace {{state.xxx}} patterns (supports nested paths like state.user.name)
    result = result.replace(/\{\{state\.(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
        // Get value from state (handles nested paths)
        const value = getNestedProperty(state, path);
        // If value exists, convert to string; otherwise leave template variable as-is
        if (value !== undefined) {
            if (typeof value === 'object' && value !== null) {
                return JSON.stringify(value);
            }
            return String(value);
        } else {
            // Fallback: try data. prefix (migration support)
            if (!path.startsWith('data.')) {
                const dataPath = `data.${path}`;
                const dataValue = getNestedProperty(state, dataPath);
                if (dataValue !== undefined) {
                    // console.log(`[TemplateRenderer] Legacy variable 'state.${path}' not found, using 'state.${dataPath}' instead`);
                    return String(dataValue);
                }
            }
            console.warn(`[TemplateRenderer] Variable not found: state.${path}`);
            return match; // Return original {{state.xxx}} if not found
        }
    });
    // Multi-pass: if result still contains unresolved templates after first pass,
    // do one more pass (handles {{parameters.X}} resolving to {{state.Y}})
    if (result !== template && (result.includes('{{state.') || result.includes('{{parameters.'))) {
        result = renderTemplate(result, state);
    }
    return result;
}

/**
 * Render parameters object by replacing template variables in all string values
 *
 * Used for tool parameters where multiple fields may contain template variables.
 * Supports both {{state.xxx}} and {{parameters.xxx}} syntax.
 *
 * For pure template references like "{{parameters.temperature}}" that map to a
 * numeric value, the original type is preserved (not converted to string).
 *
 * Example:
 * renderParameters(
 *   { query: "{{state.search}}", temp: "{{parameters.temperature}}", maxResults: 5 },
 *   { search: "TypeScript", parameters: { temperature: 0.7 } }
 * )
 * // Returns: { query: "TypeScript", temp: 0.7, maxResults: 5 }
 *
 * @param parameters - Object with potentially templated string values
 * @param state - State object containing values to substitute
 * @returns New object with template variables replaced
 */
export function renderParameters(parameters: Record<string, any>, state: any): Record<string, any> {
    const rendered: Record<string, any> = {};
    if (!parameters || typeof parameters !== 'object') {
        return rendered;
    }
    for (const [key, value] of Object.entries(parameters)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            // Recursively render nested objects
            rendered[key] = renderParameters(value, state);
        } else {
            // Use resolveValue for everything — handles primitives, templates, IIFEs, mixed strings
            const resolved = resolveValue(value, state);
            rendered[key] = resolved;
        }
    }
    return rendered;
}

/**
 * Get a nested property from an object using dot notation
 *
 * Examples:
 * getNestedProperty({ user: { name: "Alice" } }, "user.name")
 * // Returns: "Alice"
 *
 * getNestedProperty({ user: { name: "Alice" } }, "user.age")
 * // Returns: undefined
 *
 * getNestedProperty({ count: 5 }, "count")
 * // Returns: 5
 *
 * @param obj - Object to extract property from
 * @param path - Dot-separated property path (e.g., 'user.name')
 * @returns Property value or undefined if not found
 */
export function getNestedProperty(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
        return current?.[key];
    }, obj);
}

/**
 * Unified value resolver — the single entry point for all template evaluation.
 *
 * Rules (applied in order):
 * 1. Non-string values are returned as-is (preserves boolean, number, null, object).
 * 2. Pure template expressions (exactly `{{...}}` with nothing outside):
 *    a. Try simple path resolution first (state.xxx, parameters.xxx).
 *    b. If that returns undefined OR the expression is complex (operators, ternary,
 *       function calls, array indexing, etc.), evaluate via `new Function` with
 *       `state` in scope — this preserves the actual JS type of the result.
 * 3. Mixed template strings (contain `{{...}}` but also surrounding text) fall back
 *    to `renderTemplate`, which always returns a string.
 * 4. Strings with no template markers are returned as-is.
 *
 * Examples:
 *   resolveValue('{{true}}', state)                                  → true  (boolean)
 *   resolveValue('{{false}}', state)                                 → false (boolean)
 *   resolveValue('{{42}}', state)                                    → 42    (number)
 *   resolveValue('{{state.data.triggerType}}', state)                → actual value (preserves type)
 *   resolveValue('{{parameters.ns}}', state)                         → actual value (preserves type)
 *   resolveValue('{{state.x === "y" ? true : false}}', state)        → boolean
 *   resolveValue('{{state.plan.steps[state.idx || 0]}}', state)      → object/undefined
 *   resolveValue('hello {{state.name}}', state)                      → 'hello Alice' (string)
 *   resolveValue(42, state)                                          → 42    (non-string passthrough)
 *   resolveValue(true, state)                                        → true  (non-string passthrough)
 *
 * @param value - The value to resolve. May be any type.
 * @param state - Current graph state (includes `parameters` sub-object).
 * @returns Resolved value, type-preserving for pure expressions.
 */
export function resolveValue(value: any, state: any): any {
    // Rule 1: non-strings pass through unchanged
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();

    // Rule 2: pure template expression — starts with {{ and ends with }}
    // with no other text outside the braces
    if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
        const expression = trimmed.slice(2, -2).trim();

        // Detect simple path expressions: `state.a.b.c` or `parameters.a.b.c`
        // A "simple path" contains only word chars, dots, and no operators/parens/brackets/spaces
        const isSimplePath = /^(state|parameters)(\.\w+)+$/.test(expression);

        if (isSimplePath) {
            if (expression.startsWith('parameters.')) {
                const path = expression.slice('parameters.'.length);
                const resolved = getNestedProperty(state.parameters || {}, path);
                if (resolved !== undefined) {
                    return resolved;
                }
                // Fall through to new Function evaluation if not found
            } else {
                // state.xxx
                const path = expression.slice('state.'.length);
                const resolved = getNestedProperty(state, path);
                if (resolved !== undefined) {
                    return resolved;
                }
                // Try data. fallback (migration support)
                if (!path.startsWith('data.')) {
                    const dataValue = getNestedProperty(state, `data.${path}`);
                    if (dataValue !== undefined) {
                        return dataValue;
                    }
                }
                // Fall through to new Function evaluation if not found
            }
        }

        // Complex expression (or simple path that returned undefined) — evaluate via new Function
        try {
            // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
            const evalFunc = new Function('state', `return (${expression})`);
            return evalFunc(state);
        } catch (error) {
            console.error('[TemplateRenderer] resolveValue: failed to evaluate expression:', expression, error);
            // Return the original string on error so callers see something useful
            return value;
        }
    }

    // Rule 3: mixed template string (has {{ but not pure) — string interpolation only
    if (value.includes('{{')) {
        return renderTemplate(value, state);
    }

    // Rule 4: no templates — return as-is
    return value;
}

/**
 * Check if a string contains any template variables
 *
 * Useful for optimization - skip rendering if no variables present.
 * Checks for {{state.xxx}}, {{parameters.xxx}}, and {{globalState.xxx}} patterns.
 *
 * @param str - String to check
 * @returns True if string contains template patterns
 */
export function hasTemplateVariables(str: string): boolean {
    return /\{\{(state|parameters|globalState)\.\w+(?:\.\w+)*\}\}/.test(str);
}

/**
 * Check if a string contains globalState template variables
 *
 * @param str - String to check
 * @returns True if string contains globalState template patterns
 */
export function hasGlobalStateVariables(str: string): boolean {
    return /\{\{globalState\.\w+(?:\.\w+)*\}\}/.test(str);
}

/**
 * Extract all template variable names from a string
 *
 * Useful for validation - check if all required state/parameter fields are present.
 *
 * Example:
 * extractTemplateVariables("Hello {{state.user.name}}, temp: {{parameters.temperature}}")
 * // Returns: [{ type: "state", path: "user.name" }, { type: "parameters", path: "temperature" }]
 *
 * @param template - Template string
 * @returns Array of variable info objects
 */
export function extractTemplateVariables(template: string): Array<{ type: 'state' | 'parameters' | 'globalState'; path: string }> {
    const matches = template.matchAll(/\{\{(state|parameters|globalState)\.(\w+(?:\.\w+)*)\}\}/g);
    return Array.from(matches, match => ({ type: match[1] as 'state' | 'parameters' | 'globalState', path: match[2] }));
}

/**
 * Render a template string asynchronously, including globalState lookups
 *
 * Use this version when the template may contain {{globalState.namespace.key}} variables.
 * GlobalState values are fetched from persistent storage.
 *
 * @param template - Template string with {{state.xxx}}, {{parameters.xxx}}, or {{globalState.namespace.key}} placeholders
 * @param state - State object containing values to substitute
 * @returns Promise resolving to rendered string with variables replaced
 */
export async function renderTemplateAsync(template: string, state: any): Promise<string> {
    // First, do synchronous replacements for state and parameters
    let result = renderTemplate(template, state);
    // Check if there are any globalState variables to resolve
    if (!hasGlobalStateVariables(result)) {
        return result;
    }
    // Find all globalState references
    const globalStateMatches = Array.from(result.matchAll(/\{\{globalState\.(\w+(?:\.\w+)*)\}\}/g));
    if (globalStateMatches.length === 0) {
        return result;
    }
    // Fetch all values in parallel
    const client = getGlobalStateClient();
    const replacements = await Promise.all(globalStateMatches.map(async (match) => {
        const fullMatch = match[0];
        const path = match[1];
        const value = await client.resolveTemplatePath(path);
        return { fullMatch, value };
    }));
    // Apply replacements
    for (const { fullMatch, value } of replacements) {
        if (value !== undefined) {
            const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
            result = result.replace(fullMatch, stringValue);
        }
        // Leave as-is if undefined (original behavior)
    }
    return result;
}

/**
 * Render parameters object asynchronously, including globalState lookups
 *
 * Use this version when parameters may contain {{globalState.namespace.key}} variables.
 *
 * @param parameters - Object with potentially templated string values
 * @param state - State object containing values to substitute
 * @returns Promise resolving to new object with template variables replaced
 */
export async function renderParametersAsync(parameters: Record<string, any>, state: any): Promise<Record<string, any>> {
    const rendered: Record<string, any> = {};
    for (const [key, value] of Object.entries(parameters)) {
        if (typeof value === 'string' && hasTemplateVariables(value)) {
            // Use async rendering if globalState variables present
            if (hasGlobalStateVariables(value)) {
                rendered[key] = await renderTemplateAsync(value, state);
            } else {
                rendered[key] = renderTemplate(value, state);
            }
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            // Recursively render nested objects
            rendered[key] = await renderParametersAsync(value, state);
        } else {
            // Keep non-string values as-is
            rendered[key] = value;
        }
    }
    return rendered;
}

/**
 * Pre-fetch globalState namespaces mentioned in a template
 *
 * Call this before rendering to ensure all globalState values are cached.
 * This optimizes performance by batching requests.
 *
 * @param template - Template string to analyze
 */
export async function prefetchGlobalStateForTemplate(template: string): Promise<void> {
    const matches = template.matchAll(/\{\{globalState\.(\w+)\.\w+(?:\.\w+)*\}\}/g);
    const namespaces = new Set<string>();
    for (const match of matches) {
        namespaces.add(match[1]);
    }
    if (namespaces.size === 0) return;
    const client = getGlobalStateClient();
    await Promise.all(Array.from(namespaces).map(ns => client.prefetch(ns)));
}
