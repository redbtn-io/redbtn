"use strict";
/**
 * Condition Evaluator
 *
 * Phase 1: Dynamic Graph System
 * Safely evaluates conditional edge expressions without using eval().
 * Uses an allowlist-based approach for security.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createConditionFunction = createConditionFunction;
/**
 * Creates a condition function from a string expression.
 *
 * Supports common patterns:
 * - "state.field === 'value'"
 * - "state.field !== 'value'"
 * - "state.field > 10"
 * - "state.field && state.field.length > 0"
 * - "state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length"
 *
 * @param expression Condition string (JavaScript-like syntax)
 * @param targets Map of condition results to target node IDs
 * @param fallback Default node ID if condition false
 * @returns Function that evaluates condition and returns next node ID
 */
function createConditionFunction(expression, targets, fallback) {
    // If no expression, return fallback
    if (!expression || expression.trim() === '') {
        return () => fallback || '__end__';
    }
    // Validate expression safety
    if (!isSafeExpression(expression)) {
        console.warn(`[ConditionEvaluator] Unsafe expression detected, using fallback: ${expression}`);
        return () => fallback || '__end__';
    }
    // Return function that evaluates expression
    return (state) => {
        try {
            const result = evaluateExpression(expression, state);
            // Convert result to string for comparison/lookup
            const resultStr = result === undefined || result === null ? String(result) : String(result);
            // If targets provided, return the KEY that matches (not the value)
            // LangGraph's addConditionalEdges expects the condition function to return a key from targetMap
            if (targets && typeof targets === 'object') {
                // If resultStr matches a target KEY, return it directly
                if (Object.prototype.hasOwnProperty.call(targets, resultStr)) {
                    const targetNode = targets[resultStr];
                    console.log(`[ConditionEvaluator] Condition "${expression}" → result: "${resultStr}" (matched key) → target node: ${targetNode}`);
                    return resultStr; // key
                }
                // If resultStr equals a target NODE ID (value), map back to the corresponding key
                const keyForNode = Object.keys(targets).find(k => String(targets[k]) === resultStr);
                if (keyForNode) {
                    console.log(`[ConditionEvaluator] Condition "${expression}" → result: "${resultStr}" (matched node id) → mapped key: ${keyForNode}`);
                    return keyForNode;
                }
                // Result doesn't match any known key or node id, log diagnostic info and use fallback
                const availableKeys = Object.keys(targets).join(', ');
                const availableNodes = Object.values(targets).join(', ');
                const fallbackResult = fallback ? '__fallback__' : '__end__';
                console.warn(`[ConditionEvaluator] Condition "${expression}" → result: "${resultStr}" did not match keys [${availableKeys}] or nodes [${availableNodes}]. Using fallback: ${fallbackResult}`);
                return fallbackResult;
            }
            // If result is boolean, use it for branching
            if (typeof result === 'boolean') {
                if (result && (targets === null || targets === void 0 ? void 0 : targets['true'])) {
                    // Note: this branch returns a KEY or fallback depending on targets shape
                    return 'true';
                }
                // No match, use fallback key for LangGraph routing
                return fallback ? '__fallback__' : '__end__';
            }
            // No targets map and no boolean - shouldn't happen in valid configs
            // Default to fallback for safety
            return fallback ? '__fallback__' : '__end__';
        }
        catch (error) {
            console.error(`[ConditionEvaluator] Error evaluating "${expression}":`, error);
            return fallback ? '__fallback__' : '__end__';
        }
    };
}
/**
 * Validates that expression only uses safe patterns
 * Allowlist-based approach for security
 */
function isSafeExpression(expr) {
    const trimmed = expr.trim();
    // Allowlist of safe patterns
    const safePatterns = [
        // Simple property access: state.field or state.field.nested
        /^state\.\w+(\.\w+)*$/,
        // Shorthand property access: just field or field.nested (will be auto-prefixed)
        /^\w+(\.\w+)*$/,
        // Comparisons: state.field === 'value'
        /^state\.\w+(\.\w+)* (===|!==|>|<|>=|<=) .+$/,
        // Logical AND: state.field1 && state.field2
        /^state\.\w+(\.\w+)* && state\.\w+(\.\w+)*$/,
        // Logical OR: state.field1 || state.field2
        /^state\.\w+(\.\w+)* \|\| state\.\w+(\.\w+)*$/,
        // Complex comparison with logical AND
        /^state\.\w+(\.\w+)* && state\.\w+(\.\w+)* (<|>|<=|>=) state\.\w+(\.\w+)*$/
    ];
    // Check if expression matches any safe pattern
    const isSafe = safePatterns.some(pattern => pattern.test(trimmed));
    // Additional check: no dangerous keywords
    const dangerousKeywords = ['eval', 'Function', 'constructor', '__proto__', 'prototype'];
    const hasDangerousKeyword = dangerousKeywords.some(keyword => trimmed.includes(keyword));
    return isSafe && !hasDangerousKeyword;
}
/**
 * Evaluates expression against state object
 * Only supports safe, predefined patterns
 */
function evaluateExpression(expr, state) {
    var _a;
    let trimmed = expr.trim();
    // Auto-prefix shorthand expressions with 'state.'
    // If expression doesn't start with 'state.' and is just a property path, add it
    if (!trimmed.startsWith('state.') && /^\w+(\.\w+)*$/.test(trimmed)) {
        trimmed = `state.${trimmed}`;
    }
    // Pattern 1: Comparisons (state.field === 'value')
    const comparisonMatch = trimmed.match(/^state\.(\w+(?:\.\w+)*) (===|!==|>|<|>=|<=) (.+)$/);
    if (comparisonMatch) {
        const [, path, operator, valueStr] = comparisonMatch;
        const leftValue = getNestedProperty(state, path);
        const rightValue = parseValue(valueStr);
        switch (operator) {
            case '===': return leftValue === rightValue;
            case '!==': return leftValue !== rightValue;
            case '>': return leftValue > rightValue;
            case '<': return leftValue < rightValue;
            case '>=': return leftValue >= rightValue;
            case '<=': return leftValue <= rightValue;
            default: return false;
        }
    }
    // Pattern 2: Logical AND (state.field1 && state.field2)
    const andMatch = trimmed.match(/^state\.(\w+(?:\.\w+)*) && state\.(\w+(?:\.\w+)*)$/);
    if (andMatch) {
        const [, path1, path2] = andMatch;
        const value1 = getNestedProperty(state, path1);
        const value2 = getNestedProperty(state, path2);
        return Boolean(value1 && value2);
    }
    // Pattern 3: Logical OR (state.field1 || state.field2)
    const orMatch = trimmed.match(/^state\.(\w+(?:\.\w+)*) \|\| state\.(\w+(?:\.\w+)*)$/);
    if (orMatch) {
        const [, path1, path2] = orMatch;
        const value1 = getNestedProperty(state, path1);
        const value2 = getNestedProperty(state, path2);
        return Boolean(value1 || value2);
    }
    // Pattern 4: Complex comparison with AND
    const complexMatch = trimmed.match(/^state\.(\w+(?:\.\w+)*) && state\.(\w+(?:\.\w+)*) (<|>|<=|>=) state\.(\w+(?:\.\w+)*)$/);
    if (complexMatch) {
        const [, path1, path2, operator, path3] = complexMatch;
        const value1 = getNestedProperty(state, path1);
        const value2 = getNestedProperty(state, path2);
        const value3 = getNestedProperty(state, path3);
        if (!value1)
            return false;
        switch (operator) {
            case '<': return value2 < value3;
            case '>': return value2 > value3;
            case '<=': return value2 <= value3;
            case '>=': return value2 >= value3;
            default: return false;
        }
    }
    // Pattern 5: Simple property access (state.field)
    const propMatch = trimmed.match(/^state\.(\w+(?:\.\w+)*)$/);
    if (propMatch) {
        const [, path] = propMatch;
        const value = getNestedProperty(state, path);
        console.log(`[ConditionEvaluator] Simple property access: state.${path} = ${(_a = JSON.stringify(value)) === null || _a === void 0 ? void 0 : _a.substring(0, 100)}`);
        return value;
    }
    throw new Error(`Unable to parse expression: ${expr}`);
}
/**
 * Gets nested property from object using dot notation
 * Example: getNestedProperty(obj, 'a.b.c') returns obj.a.b.c
 */
function getNestedProperty(obj, path) {
    if (!obj || typeof obj !== 'object') {
        return undefined;
    }
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current === null || current === undefined) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}
/**
 * Parses value string to appropriate type
 * Handles strings, numbers, booleans, null, undefined
 */
function parseValue(value) {
    const trimmed = value.trim();
    // String literals (single or double quotes)
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
        return trimmed.slice(1, -1);
    }
    // Numbers (integers and floats)
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return parseFloat(trimmed);
    }
    // Booleans
    if (trimmed === 'true')
        return true;
    if (trimmed === 'false')
        return false;
    // Null
    if (trimmed === 'null')
        return null;
    // Undefined
    if (trimmed === 'undefined')
        return undefined;
    // Property reference (state.something)
    if (trimmed.startsWith('state.')) {
        // This shouldn't happen in normal flow, but handle it
        return trimmed;
    }
    // Default: return as string
    return trimmed;
}
