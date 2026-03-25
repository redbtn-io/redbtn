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
    // Handle undefined or null parameters
    if (!parameters || typeof parameters !== 'object') {
        return rendered;
    }
    for (const [key, value] of Object.entries(parameters)) {
        // Try to parse JSON strings for body/payload fields
        let processValue = value;
        if (typeof value === 'string' && (key === 'body' || key === 'payload' || key === 'data')) {
            // Check if it looks like JSON
            const trimmed = value.trim();
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try {
                    processValue = JSON.parse(value);
                } catch {
                    // Not valid JSON, keep as string
                    processValue = value;
                }
            }
        }
        if (typeof processValue === 'string' && (processValue.includes('{{state.') || processValue.includes('{{parameters.'))) {
            // Check if this is a pure parameter reference that should preserve type
            const paramMatch = processValue.match(/^\{\{parameters\.(\w+)\}\}$/);
            if (paramMatch && state.parameters) {
                const paramName = paramMatch[1];
                const resolved = state.parameters[paramName];
                if (resolved !== undefined) {
                    // Multi-pass: if the resolved value is itself a template string, resolve it
                    if (typeof resolved === 'string' && (resolved.includes('{{state.') || resolved.includes('{{parameters.'))) {
                        // Check for pure state ref (type-preserving)
                        const innerStateMatch = resolved.match(/^\{\{state\.(.+)\}\}$/);
                        if (innerStateMatch) {
                            const innerResolved = getNestedProperty(state, innerStateMatch[1]);
                            if (innerResolved !== undefined) {
                                rendered[key] = innerResolved;
                                continue;
                            }
                        }
                        // Complex template — string render
                        rendered[key] = renderTemplate(resolved, state);
                        continue;
                    }
                    // Preserve original type (number, boolean, etc.)
                    rendered[key] = resolved;
                    continue;
                }
            }
            // Check if this is a pure state reference that should preserve type
            // Preserves primitives, objects, and arrays (for MCP tool params that accept complex types)
            const stateMatch = processValue.match(/^\{\{state\.(.+)\}\}$/);
            if (stateMatch) {
                const path = stateMatch[1];
                const resolved = getNestedProperty(state, path);
                if (resolved !== undefined) {
                    rendered[key] = resolved;
                    continue;
                }
            }
            // For complex templates or strings, use string rendering
            rendered[key] = renderTemplate(processValue, state);
        } else if (typeof processValue === 'object' && processValue !== null && !Array.isArray(processValue)) {
            // Recursively render nested objects
            rendered[key] = renderParameters(processValue, state);
        } else {
            // Keep non-string values as-is
            rendered[key] = processValue;
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
