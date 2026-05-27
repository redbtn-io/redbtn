"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedGraphState = void 0;
const langgraph_1 = require("@langchain/langgraph");
/**
 * 1. Define the State using Annotation
 * This is the shared memory object that flows between nodes.
 *
 * IMPORTANT: Infrastructure objects (RunPublisher, NeuronRegistry, McpClient,
 * Memory, ConnectionManager, GraphRegistry, etc.) are deliberately NOT declared
 * as channels. They live in `runControlRegistry` (lib/run/RunControlRegistry.ts)
 * keyed by `state.runId`. Step executors read them via the `getX(state)` helpers
 * in `lib/run/contextLookup.ts`.
 *
 * Why: those objects carry references to Mongoose internals — specifically
 * `runPublisher.redlog._mongooseLib.default.mongo.BSON.bsonType` is a
 * `Symbol(@@mdb.bson.type)`. `JSON.stringify` throws on Symbols.
 * `fast-safe-stringify` (LangGraph's serializer) catches the throw and
 * substitutes a 69-byte placeholder string. The placeholder later deserializes
 * to a string, and LangGraph's `_first()` crashes with
 * `Cannot read properties of undefined (reading '__input__')`. Keeping them
 * out of state is the only way to make checkpoints serialize cleanly.
 */
exports.RedGraphState = langgraph_1.Annotation.Root({
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
    // Node execution counter for system prompts
    nodeCounter: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => 1
    }),
    // Subgraph depth counter (prevents infinite recursion)
    _subgraphDepth: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y !== null && y !== void 0 ? y : x,
        default: () => 0
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
