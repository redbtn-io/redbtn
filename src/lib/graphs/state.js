"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedGraphState = void 0;
const langgraph_1 = require("@langchain/langgraph");
/**
 * 1. Define the State using Annotation
 * This is the shared memory object that flows between nodes.
 */
exports.RedGraphState = langgraph_1.Annotation.Root({
    // Infrastructure components (available to all nodes)
    neuronRegistry: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y
    }),
    mcpClient: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y
    }),
    memory: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y
    }),
    // messageQueue removed in v0.0.51-alpha — legacy respond() path deleted.
    // RunPublisher (state.runPublisher) is the unified event publishing mechanism.
    logger: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y
    }),
    // NEW: RunPublisher for unified event publishing (run path)
    // Connection manager for OAuth/API key credential resolution
    connectionManager: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y !== null && y !== void 0 ? y : x
    }),
    runPublisher: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y !== null && y !== void 0 ? y : x // Keep existing if new is null/undefined
    }),
    // Graph event publisher for live visualization
    graphPublisher: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y !== null && y !== void 0 ? y : x // Keep existing if new is null/undefined
    }),
    // Message ID for SSE event streaming
    messageId: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y !== null && y !== void 0 ? y : x
    }),
    // Graph metadata for event publishing
    graphName: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y !== null && y !== void 0 ? y : x
    }),
    graphId: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y !== null && y !== void 0 ? y : x
    }),
    // Universal Node Data - Container for all node-specific dynamic data
    // Use this for ANY data that is specific to a node/feature and not truly generic
    // Examples: executionPlan, currentStep, searchResults, routingDecision, etc.
    data: (0, langgraph_1.Annotation)({
        reducer: (x, y) => {
            // Deep merge nested objects so data.executionPlan + data.hasPlan don't overwrite each other
            return deepMergeData(x, y);
        },
        default: () => ({})
    }),
    // MCP Registry for universal nodes (Phase 2: Tool execution from config)
    mcpRegistry: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y
    }),
    // Node execution counter for system prompts
    nodeCounter: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => 1
    })
});
/**
 * Deep merge for data field reducer
 * Recursively merges nested objects to preserve all nested fields
 */
function deepMergeData(target, source) {
    const sourceKeys = Object.keys(source || {});
    if (sourceKeys.includes('messages') || sourceKeys.includes('contextMessages')) {
        console.log('[DataReducer] MESSAGES DETECTED! Deep merging data:', {
            targetKeys: Object.keys(target || {}),
            sourceKeys: sourceKeys,
            messagesType: Array.isArray(source === null || source === void 0 ? void 0 : source.messages) ? 'array' : typeof (source === null || source === void 0 ? void 0 : source.messages)
        });
    }
    const result = Object.assign({}, target);
    for (const key of Object.keys(source)) {
        // For messages: REPLACE rather than concat to prevent duplication
        // Messages are built fresh by context node, not incrementally added
        if (key === 'messages' && Array.isArray(source[key])) {
            result[key] = source[key]; // Replace, don't concat
        }
        else if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            // Recursively merge nested objects
            result[key] = deepMergeData(result[key] || {}, source[key]);
        }
        else {
            // Directly assign primitives, arrays, and null values
            result[key] = source[key];
        }
    }
    const resultKeys = Object.keys(result);
    if (resultKeys.includes('messages') || resultKeys.includes('contextMessages')) {
        console.log('[DataReducer] MESSAGES IN RESULT! Merge result keys:', resultKeys);
    }
    return result;
}
