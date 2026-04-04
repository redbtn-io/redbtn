"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeConditional = executeConditional;
const templateRenderer_1 = require("../templateRenderer");
// Debug logging - set to true to enable verbose logs
const DEBUG = false;
/**
 * Execute a conditional step
 *
 * Flow:
 * 1. Render condition template with current state
 * 2. Evaluate condition to boolean
 * 3. Set output field to trueValue or falseValue based on result
 *
 * Example:
 * condition: "{{state.searchResults.length}} > 0"
 * setField: "hasResults"
 * trueValue: true
 * falseValue: false
 *
 * Result: { hasResults: true } if searchResults has items
 *
 * @param config - Conditional step configuration
 * @param state - Current graph state (includes accumulated updates from previous steps)
 * @returns Partial state with setField set to trueValue or falseValue
 */
function executeConditional(config, state) {
    var _a, _b, _c, _d, _e;
    console.log('[ConditionalExecutor] ====== STARTING CONDITIONAL ======');
    console.log('[ConditionalExecutor] Condition:', config.condition);
    console.log('[ConditionalExecutor] SetField:', config.setField);
    console.log('[ConditionalExecutor] TrueValue:', config.trueValue);
    console.log('[ConditionalExecutor] FalseValue:', config.falseValue);
    try {
        // Check if condition is a JavaScript expression (wrapped in {{ }})
        let conditionStr;
        let result;
        const trimmedCondition = config.condition.trim();
        // DEBUG: Log what we're checking
        if (DEBUG)
            console.log('[ConditionalExecutor] Checking condition:', {
                original: config.condition,
                trimmed: trimmedCondition
            });
        if (trimmedCondition.startsWith('{{') && trimmedCondition.endsWith('}}')) {
            // Evaluate as JavaScript expression
            const expression = trimmedCondition.slice(2, -2).trim();
            try {
                // Special logging for executionPlan validation
                if (DEBUG && expression.includes('executionPlan')) {
                    console.log('[ConditionalExecutor] DEBUG - Validating executionPlan:', {
                        expression,
                        hasSteps: !!((_b = (_a = state.data) === null || _a === void 0 ? void 0 : _a.executionPlan) === null || _b === void 0 ? void 0 : _b.steps),
                        stepsLength: (_e = (_d = (_c = state.data) === null || _c === void 0 ? void 0 : _c.executionPlan) === null || _d === void 0 ? void 0 : _d.steps) === null || _e === void 0 ? void 0 : _e.length
                    });
                }
                // For simple existence checks, avoid passing the entire state to prevent stack overflow
                // Patterns we want to match:
                // - state.data.field !== undefined
                // - state.data.field !== undefined && state.data.field !== null
                // - state.data.field !== null
                const existencePatterns = [
                    // state.data.field !== undefined && state.data.field !== null
                    /^(state(?:\.\w+)+)\s*!==\s*undefined\s*&&\s*\1\s*!==\s*null$/,
                    // state.data.field !== null && state.data.field !== undefined
                    /^(state(?:\.\w+)+)\s*!==\s*null\s*&&\s*\1\s*!==\s*undefined$/,
                    // state.data.field !== undefined
                    /^(state(?:\.\w+)+)\s*!==\s*undefined$/,
                    // state.data.field !== null
                    /^(state(?:\.\w+)+)\s*!==\s*null$/,
                ];
                let matchedPath = null;
                for (const pattern of existencePatterns) {
                    const match = expression.match(pattern);
                    if (match) {
                        matchedPath = match[1]; // e.g., "state.data.contextMessages"
                        break;
                    }
                }
                if (matchedPath) {
                    // Extract path after "state."
                    const path = matchedPath.substring(6); // Remove "state."
                    const parts = path.split('.');
                    let value = state;
                    for (const part of parts) {
                        value = value === null || value === void 0 ? void 0 : value[part];
                    }
                    result = value !== undefined && value !== null;
                    conditionStr = trimmedCondition;
                    if (DEBUG)
                        console.log('[ConditionalExecutor] Fast existence check:', { path: matchedPath, result });
                }
                else {
                    // Create a minimal state object for evaluation to avoid stack overflow
                    // when state contains large objects or circular references
                    const evalFunc = new Function('state', `
            try {
              return ${expression};
            } catch (innerError) {
              // Handle evaluation errors gracefully
              return false;
            }
          `);
                    result = Boolean(evalFunc(state));
                    conditionStr = trimmedCondition; // Keep original for logging
                }
                if (DEBUG)
                    console.log('[ConditionalExecutor] Evaluated JS condition:', {
                        expression,
                        result
                    });
            }
            catch (error) {
                console.error('[ConditionalExecutor] Failed to evaluate JS condition:', expression, error);
                // Fall back to template rendering
                conditionStr = (0, templateRenderer_1.renderTemplate)(config.condition, state);
                result = evaluateCondition(conditionStr);
            }
        }
        else {
            // Render condition template with current state
            conditionStr = (0, templateRenderer_1.renderTemplate)(config.condition, state);
            // Evaluate condition
            result = evaluateCondition(conditionStr);
        }
        // Evaluate or render true/false values (they might contain JavaScript expressions or templates)
        const trueValue = typeof config.trueValue === 'string'
            ? evaluateValue(config.trueValue, state)
            : config.trueValue;
        const falseValue = typeof config.falseValue === 'string'
            ? evaluateValue(config.falseValue, state)
            : config.falseValue;
        // Debug logging
        if (DEBUG)
            console.log(`[ConditionalExecutor] Condition result: ${result} → setting ${config.setField}`);
        // Return appropriate value
        return {
            [config.setField]: result ? trueValue : falseValue
        };
    }
    catch (error) {
        throw new Error(`Conditional step failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Evaluate a value that might be a JavaScript expression or a template
 *
 * If the value is wrapped in {{ }}, evaluate it as JavaScript (supports optional chaining, etc.)
 * Otherwise, use the template renderer for simple {{state.field}} substitutions
 *
 * @param valueStr - Value string to evaluate
 * @param state - Current state for evaluation
 * @returns Evaluated value
 */
function evaluateValue(valueStr, state) {
    const trimmed = valueStr.trim();
    // If it's a JavaScript expression (wrapped in {{ }}), evaluate it
    if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
        const expression = trimmed.slice(2, -2).trim();
        try {
            // Create a function that evaluates the expression with state in scope
            const evalFunc = new Function('state', `return ${expression}`);
            const result = evalFunc(state);
            if (DEBUG)
                console.log('[ConditionalExecutor] Evaluated JS expression:', {
                    expression,
                    resultType: typeof result
                });
            return result;
        }
        catch (error) {
            console.error('[ConditionalExecutor] Failed to evaluate expression:', expression, error);
            // Fall back to template rendering
            return (0, templateRenderer_1.renderTemplate)(valueStr, state);
        }
    }
    // Otherwise use template rendering for simple substitutions
    return (0, templateRenderer_1.renderTemplate)(valueStr, state);
}
/**
 * Strip surrounding quotes from a string
 * Handles both single and double quotes
 */
function stripQuotes(str) {
    const trimmed = str.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
/**
 * Evaluate a boolean condition
 *
 * Supports:
 * - Boolean literals: "true", "false"
 * - Comparison operators: >, >=, <, <=, ==, !=, ===, !==
 * - Numeric comparisons: "5 > 3" → true
 * - String comparisons: "search === 'search'" → true (quotes stripped)
 * - Existence checks: non-empty string → true, empty/0 → false
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
    // Safety: If the condition string is very long (likely contains serialized data),
    // skip recursive parsing which could cause stack overflow
    if (trimmed.length > 10000) {
        // For very long strings, just check for truthiness
        // Non-empty, non-null, non-undefined means truthy
        return trimmed !== 'null' && trimmed !== 'undefined' && trimmed !== '0';
    }
    // Handle logical OR (||) - but only if it looks like a logical expression
    // and not embedded in a JSON string (check for balanced quotes)
    if (trimmed.includes(' || ') && !looksLikeJson(trimmed)) {
        const parts = trimmed.split(' || ');
        return parts.some(part => evaluateCondition(part.trim()));
    }
    // Handle logical AND (&&) - same safety check
    if (trimmed.includes(' && ') && !looksLikeJson(trimmed)) {
        const parts = trimmed.split(' && ');
        return parts.every(part => evaluateCondition(part.trim()));
    }
    // Comparison operators (supports ==, !=, ===, !==, <, >, <=, >=)
    const comparisonRegex = /^(.+?)\s*([<>]=?|[!=]==?)\s*(.+)$/;
    const match = trimmed.match(comparisonRegex);
    if (match) {
        const [, left, operator, right] = match;
        // Try numeric comparison
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
        // String comparison - strip quotes from both sides
        const leftStr = stripQuotes(left.trim());
        const rightStr = stripQuotes(right.trim());
        switch (operator) {
            case '==':
            case '===': return leftStr === rightStr;
            case '!=':
            case '!==': return leftStr !== rightStr;
        }
    }
    // Existence check: non-empty string is truthy
    return trimmed.length > 0 && trimmed !== '0' && trimmed !== 'null' && trimmed !== 'undefined';
}
/**
 * Check if a string looks like JSON (starts with [ or {)
 * Used to avoid splitting JSON content on logical operators
 */
function looksLikeJson(str) {
    const trimmed = str.trim();
    return (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}'));
}
