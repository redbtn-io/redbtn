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
/**
 * Render a template string by replacing {{state.field}} and {{parameters.field}} variables
 *
 * Supports nested property access via dot notation.
 *
 * @param template - Template string with {{state.field}} or {{parameters.field}} placeholders
 * @param state - State object containing values to substitute (includes parameters)
 * @returns Rendered string with variables replaced
 */
export declare function renderTemplate(template: string, state: any): string;
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
export declare function renderParameters(parameters: Record<string, any>, state: any): Record<string, any>;
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
export declare function getNestedProperty(obj: any, path: string): any;
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
export declare function resolveValue(value: any, state: any): any;
/**
 * Check if a string contains any template variables
 *
 * Useful for optimization - skip rendering if no variables present.
 * Checks for {{state.xxx}}, {{parameters.xxx}}, and {{globalState.xxx}} patterns.
 *
 * @param str - String to check
 * @returns True if string contains template patterns
 */
export declare function hasTemplateVariables(str: string): boolean;
/**
 * Check if a string contains globalState template variables
 *
 * @param str - String to check
 * @returns True if string contains globalState template patterns
 */
export declare function hasGlobalStateVariables(str: string): boolean;
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
export declare function extractTemplateVariables(template: string): Array<{
    type: 'state' | 'parameters' | 'globalState';
    path: string;
}>;
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
export declare function renderTemplateAsync(template: string, state: any): Promise<string>;
/**
 * Render parameters object asynchronously, including globalState lookups
 *
 * Use this version when parameters may contain {{globalState.namespace.key}} variables.
 *
 * @param parameters - Object with potentially templated string values
 * @param state - State object containing values to substitute
 * @returns Promise resolving to new object with template variables replaced
 */
export declare function renderParametersAsync(parameters: Record<string, any>, state: any): Promise<Record<string, any>>;
/**
 * Pre-fetch globalState namespaces mentioned in a template
 *
 * Call this before rendering to ensure all globalState values are cached.
 * This optimizes performance by batching requests.
 *
 * @param template - Template string to analyze
 */
export declare function prefetchGlobalStateForTemplate(template: string): Promise<void>;
