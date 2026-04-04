"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redGraphLegacy = exports.redGraphPlanner = exports.redGraph = void 0;
const langgraph_1 = require("@langchain/langgraph");
const router_1 = require("../nodes/router");
const planner_1 = require("../nodes/planner");
const executor_1 = require("../nodes/executor");
const responder_1 = require("../nodes/responder");
const search_1 = require("../nodes/search");
const scrape_1 = require("../nodes/scrape");
const command_1 = require("../nodes/command");
/**
 * 1. Define the State using Annotation
 * This is the shared memory object that flows between nodes.
 */
const RedGraphState = langgraph_1.Annotation.Root({
    query: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => ({})
    }),
    options: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => ({})
    }),
    // Carry the Red instance through the graph so nodes can access configured models
    redInstance: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => ({})
    }),
    // Messages array that accumulates throughout the tool calling loop
    messages: (0, langgraph_1.Annotation)({
        reducer: (x, y) => x.concat(y),
        default: () => []
    }),
    // Response contains the full AIMessage object with content, tokens, and metadata
    response: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y
    }),
    nextGraph: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    // messageId for linking to Redis pub/sub and event publishing
    messageId: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y
    }),
    // finalResponse indicates a node has generated the complete answer (skip responder LLM call)
    finalResponse: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y
    }),
    // searchIterations tracks how many times search node has looped
    searchIterations: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => 0
    }),
    // toolParam allows passing parameters between nodes (e.g., refined search query)
    toolParam: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y
    }),
    // contextMessages holds the conversation history loaded once by context node
    contextMessages: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => []
    }),
    // contextSummary stores the executive summary for quick prompting
    contextSummary: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => ''
    }),
    // contextLoaded ensures the context node only runs once per invocation
    contextLoaded: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => false
    }),
    // nodeNumber tracks current position in the graph (1st, 2nd, 3rd node, etc.)
    nodeNumber: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y, // Each node can override
        default: () => 1 // Start at 1 (planner/router)
    }),
    // PLANNER-BASED EXECUTION FIELDS
    // executionPlan holds the ordered sequence of steps planned by planner node
    executionPlan: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    // currentStepIndex points to which step in the plan is executing (0-based)
    currentStepIndex: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => 0
    }),
    // requestReplan signals that a node wants the planner to create a new plan
    requestReplan: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => false
    }),
    // replanReason explains why replanning was requested
    replanReason: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    // replannedCount tracks how many times we've replanned (max 3)
    replannedCount: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => 0
    }),
    // commandDomain and commandDetails passed from executor to command node
    commandDomain: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    commandDetails: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    // THREE-TIER ARCHITECTURE FIELDS
    // Precheck (Tier 0: Pattern matching)
    precheckDecision: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    precheckMatch: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    precheckReason: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    // Fastpath execution
    fastpathTool: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    fastpathServer: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    fastpathParameters: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    fastpathSuccess: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    fastpathResult: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    fastpathError: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    fastpathMessage: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    fastpathComplete: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    // Classifier (Tier 1: Fast LLM routing)
    routerDecision: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    routerReason: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    }),
    routerConfidence: (0, langgraph_1.Annotation)({
        reducer: (x, y) => y,
        default: () => undefined
    })
});
// --- Graph Definitions ---
// Import new nodes
const precheck_1 = require("../nodes/precheck");
const context_1 = require("../nodes/context");
const classifier_1 = require("../nodes/classifier");
const fastpath_1 = require("../nodes/fastpath");
// ROUTER GRAPH WITH PRECHECK + CLASSIFIER (new default)
// Flow: precheck → [fastpath_executor OR classifier] → [responder OR planner+executor loop]
//
// Step 1: Precheck (pattern matching)
//   - Match → fastpath_executor (placeholder for now, will be implemented later)
//   - No match → classifier
//
// Step 2: Classifier (fast LLM routing with bias toward planning)
//   - Direct → responder (simple questions, greetings, knowledge queries)
//   - Plan → planner (default, anything needing tools/multi-step)
//
// Step 3a: Responder path (direct answer)
//   - Generate response → END
//
// Step 3b: Planner path (complex execution)
//   - planner → executor → [search/scrape/command] → executor (loop) → responder → END
const redGraphBuilderRouter = new langgraph_1.StateGraph(RedGraphState)
    .addNode("precheck", precheck_1.precheckNode)
    .addNode("fastpathExecutor", fastpath_1.fastpathExecutorNode) // Placeholder - to be implemented
    .addNode("contextLoader", context_1.contextNode)
    .addNode("classifier", classifier_1.classifierNode)
    .addNode("planner", planner_1.plannerNode)
    .addNode("executor", executor_1.executorNode)
    .addNode("search", search_1.searchNode)
    .addNode("scrape", scrape_1.scrapeNode)
    .addNode("command", command_1.commandNode)
    .addNode("responder", responder_1.responderNode)
    // START → precheck
    .addEdge("__start__", "precheck")
    // PRECHECK → [fastpath_executor OR contextLoader]
    .addConditionalEdges("precheck", (state) => {
    if (state.precheckDecision === 'fastpath') {
        return 'fastpath';
    }
    return 'context';
}, {
    "fastpath": "fastpathExecutor",
    "context": "contextLoader"
})
    // CONTEXT LOADER → classifier (non-fastpath flow)
    .addEdge("contextLoader", "classifier")
    // FASTPATH → END (placeholder, will be expanded later)
    .addEdge("fastpathExecutor", langgraph_1.END)
    // CLASSIFIER → [responder OR planner]
    .addConditionalEdges("classifier", (state) => {
    if (state.routerDecision === 'direct') {
        return 'responder';
    }
    return 'planner';
}, {
    "responder": "responder",
    "planner": "planner"
})
    // PLANNER → executor (always)
    .addEdge("planner", "executor")
    // EXECUTOR → [search/scrape/command/responder] based on current step
    .addConditionalEdges("executor", (state) => {
    return state.nextGraph || "responder";
}, {
    "search": "search",
    "scrape": "scrape",
    "command": "command",
    "responder": "responder"
})
    // SEARCH → [search (loop) OR executor (next step) OR END]
    .addConditionalEdges("search", (state) => {
    // Legacy router mode support (allows search to loop back to itself)
    if (state.nextGraph === 'search') {
        return 'search';
    }
    // Check if we have more steps to execute
    if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor';
    }
    // Plan complete
    return langgraph_1.END;
}, {
    "search": "search",
    "executor": "executor",
    "__end__": langgraph_1.END
})
    // SCRAPE → [executor (next step) OR END]
    .addConditionalEdges("scrape", (state) => {
    if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor';
    }
    return langgraph_1.END;
}, {
    "executor": "executor",
    "__end__": langgraph_1.END
})
    // COMMAND → [executor (next step) OR END]
    .addConditionalEdges("command", (state) => {
    if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor';
    }
    return langgraph_1.END;
}, {
    "executor": "executor",
    "__end__": langgraph_1.END
})
    // RESPONDER → [planner (replan) OR END]
    .addConditionalEdges("responder", (state) => {
    // Check if responder requested replanning
    if (state.requestReplan && state.replannedCount < 3) {
        return 'planner';
    }
    return langgraph_1.END;
}, {
    "planner": "planner",
    "__end__": langgraph_1.END
});
// PLANNER-BASED graph (kept for reference, but three-tier is now default)
const redGraphBuilderWithPlanner = new langgraph_1.StateGraph(RedGraphState)
    .addNode("contextLoader", context_1.contextNode)
    .addNode("planner", planner_1.plannerNode) // Creates execution plan
    .addNode("executor", executor_1.executorNode) // Routes to appropriate step
    .addNode("search", search_1.searchNode) // Web search node
    .addNode("scrape", scrape_1.scrapeNode) // URL scraping node
    .addNode("command", command_1.commandNode) // Command execution node
    .addNode("responder", responder_1.responderNode) // Final response generation node
    .addEdge("__start__", "contextLoader")
    .addEdge("contextLoader", "planner")
    .addConditionalEdges("planner", (state) => {
    // After planning, check if replanning was requested
    if (state.requestReplan && state.replannedCount < 3) {
        // Exceeded max replans, go to executor anyway
        return "executor";
    }
    // Normal flow: go to executor to start executing plan
    return "executor";
}, {
    "executor": "executor"
})
    .addConditionalEdges("executor", (state) => {
    // Executor determines which specialized node to run based on current step
    return state.nextGraph || "responder";
}, {
    "search": "search",
    "scrape": "scrape",
    "command": "command",
    "responder": "responder"
})
    // After each specialized node, check if we need to continue execution or replan
    .addConditionalEdges("search", (state) => {
    // Legacy router mode support
    if (state.nextGraph === 'search') {
        return 'search'; // Old-style loop
    }
    // Check if we have more steps to execute
    if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor'; // Continue with next step
    }
    // Plan complete
    return langgraph_1.END;
}, {
    "search": "search", // Legacy loop
    "executor": "executor", // Continue plan
    "__end__": langgraph_1.END
})
    .addConditionalEdges("scrape", (state) => {
    // Check if we have more steps to execute
    if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor';
    }
    return langgraph_1.END;
}, {
    "executor": "executor",
    "__end__": langgraph_1.END
})
    .addConditionalEdges("command", (state) => {
    // Check if we have more steps to execute
    if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor';
    }
    return langgraph_1.END;
}, {
    "executor": "executor",
    "__end__": langgraph_1.END
})
    .addConditionalEdges("responder", (state) => {
    // Check if responder requested replanning
    if (state.requestReplan && state.replannedCount < 3) {
        return 'planner'; // Go back to planner for new plan
    }
    // Otherwise, we're done
    return langgraph_1.END;
}, {
    "planner": "planner",
    "__end__": langgraph_1.END
});
// LEGACY: Create ROUTER-BASED graph (old architecture, kept for backwards compatibility)
const redGraphBuilderWithRouter = new langgraph_1.StateGraph(RedGraphState)
    .addNode("contextLoader", context_1.contextNode)
    .addNode("router", router_1.routerNode)
    .addNode("search", search_1.searchNode)
    .addNode("scrape", scrape_1.scrapeNode)
    .addNode("command", command_1.commandNode)
    .addNode("responder", responder_1.responderNode)
    .addEdge("__start__", "contextLoader")
    .addEdge("contextLoader", "router")
    .addConditionalEdges("router", (state) => {
    return state.nextGraph || "responder";
}, {
    "homeGraph": langgraph_1.END,
    "assistantGraph": langgraph_1.END,
    "search": "search",
    "scrape": "scrape",
    "command": "command",
    "responder": "responder",
})
    .addConditionalEdges("search", (state) => {
    if (state.nextGraph === 'search') {
        return 'search';
    }
    return 'responder';
}, {
    "search": "search",
    "responder": "responder"
})
    .addEdge("scrape", "responder")
    .addEdge("command", "responder")
    .addEdge("responder", langgraph_1.END);
// Export ROUTER graph with precheck+classifier as default
exports.redGraph = redGraphBuilderRouter.compile();
// Export PLANNER-BASED graph for reference (direct to planner, no classifier)
exports.redGraphPlanner = redGraphBuilderWithPlanner.compile();
// Export LEGACY ROUTER-BASED graph for backwards compatibility (old single-step router)
exports.redGraphLegacy = redGraphBuilderWithRouter.compile();
