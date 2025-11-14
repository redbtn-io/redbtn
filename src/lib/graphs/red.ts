import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { InvokeOptions } from '../../index';
import { routerNode } from "../nodes/router";
import { plannerNode } from "../nodes/planner";
import { executorNode } from "../nodes/executor";
import { responderNode } from "../nodes/responder";
import { searchNode } from "../nodes/search";
import { scrapeNode } from "../nodes/scrape";
import { commandNode } from "../nodes/command";
import type { ExecutionPlan } from "../nodes/planner";

/**
 * 1. Define the State using Annotation
 * This is the shared memory object that flows between nodes.
 */
const RedGraphState = Annotation.Root({
  query: Annotation<object>({
    reducer: (x: object, y: object) => y,
    default: () => ({})
  }),
  options: Annotation<InvokeOptions>({
    reducer: (x: InvokeOptions, y: InvokeOptions) => y,
    default: () => ({})
  }),
  // Carry the Red instance through the graph so nodes can access configured models
  redInstance: Annotation<object>({
    reducer: (x: object, y: object) => y,
    default: () => ({} as object)
  }),
  // Messages array that accumulates throughout the tool calling loop
  messages: Annotation<any[]>({
    reducer: (x: any[], y: any[]) => x.concat(y),
    default: () => []
  }),
  // Response contains the full AIMessage object with content, tokens, and metadata
  response: Annotation<any>({
    reducer: (x: any, y: any) => y
  }),
  nextGraph: Annotation<'homeGraph' | 'assistantGraph' | 'responder' | 'search' | 'scrape' | 'command' | undefined>({
    reducer: (x, y) => y,
    default: () => undefined
  }),
  // messageId for linking to Redis pub/sub and event publishing
  messageId: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y
  }),
  // finalResponse indicates a node has generated the complete answer (skip responder LLM call)
  finalResponse: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y
  }),
  // searchIterations tracks how many times search node has looped
  searchIterations: Annotation<number>({
    reducer: (x: number, y: number) => y,
    default: () => 0
  }),
  // toolParam allows passing parameters between nodes (e.g., refined search query)
  toolParam: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y
  }),
  // contextMessages holds the conversation history loaded once by router
  contextMessages: Annotation<any[]>({
    reducer: (x: any[], y: any[]) => y, // Replace (router loads it once)
    default: () => []
  }),
  // nodeNumber tracks current position in the graph (1st, 2nd, 3rd node, etc.)
  nodeNumber: Annotation<number>({
    reducer: (x: number, y: number) => y, // Each node can override
    default: () => 1 // Start at 1 (planner/router)
  }),
  // PLANNER-BASED EXECUTION FIELDS
  // executionPlan holds the ordered sequence of steps planned by planner node
  executionPlan: Annotation<ExecutionPlan | undefined>({
    reducer: (x: ExecutionPlan | undefined, y: ExecutionPlan | undefined) => y,
    default: () => undefined
  }),
  // currentStepIndex points to which step in the plan is executing (0-based)
  currentStepIndex: Annotation<number>({
    reducer: (x: number, y: number) => y,
    default: () => 0
  }),
  // requestReplan signals that a node wants the planner to create a new plan
  requestReplan: Annotation<boolean>({
    reducer: (x: boolean, y: boolean) => y,
    default: () => false
  }),
  // replanReason explains why replanning was requested
  replanReason: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y,
    default: () => undefined
  }),
  // replannedCount tracks how many times we've replanned (max 3)
  replannedCount: Annotation<number>({
    reducer: (x: number, y: number) => y,
    default: () => 0
  }),
  // commandDomain and commandDetails passed from executor to command node
  commandDomain: Annotation<'system' | 'api' | 'home' | undefined>({
    reducer: (x: any, y: any) => y,
    default: () => undefined
  }),
  commandDetails: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y,
    default: () => undefined
  }),
  // THREE-TIER ARCHITECTURE FIELDS
  // Precheck (Tier 0: Pattern matching)
  precheckDecision: Annotation<'fastpath' | 'router' | undefined>({
    reducer: (x: any, y: any) => y,
    default: () => undefined
  }),
  precheckMatch: Annotation<any | undefined>({
    reducer: (x: any, y: any) => y,
    default: () => undefined
  }),
  precheckReason: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y,
    default: () => undefined
  }),
  // Fastpath execution
  fastpathTool: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y,
    default: () => undefined
  }),
  fastpathServer: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y,
    default: () => undefined
  }),
  fastpathParameters: Annotation<Record<string, string> | undefined>({
    reducer: (x: any, y: any) => y,
    default: () => undefined
  }),
  fastpathSuccess: Annotation<boolean | undefined>({
    reducer: (x: boolean | undefined, y: boolean | undefined) => y,
    default: () => undefined
  }),
  fastpathResult: Annotation<any | undefined>({
    reducer: (x: any, y: any) => y,
    default: () => undefined
  }),
  fastpathError: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y,
    default: () => undefined
  }),
  fastpathMessage: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y,
    default: () => undefined
  }),
  fastpathComplete: Annotation<boolean | undefined>({
    reducer: (x: boolean | undefined, y: boolean | undefined) => y,
    default: () => undefined
  }),
  // Classifier (Tier 1: Fast LLM routing)
  routerDecision: Annotation<'direct' | 'plan' | undefined>({
    reducer: (x: any, y: any) => y,
    default: () => undefined
  }),
  routerReason: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y,
    default: () => undefined
  }),
  routerConfidence: Annotation<number | undefined>({
    reducer: (x: number | undefined, y: number | undefined) => y,
    default: () => undefined
  })
});

type RedGraphStateType = typeof RedGraphState.State;

// --- Graph Definitions ---

// Import new nodes
import { precheckNode } from "../nodes/precheck";
import { classifierNode } from "../nodes/classifier";
import { fastpathExecutorNode, tinyConfirmerNode } from "../nodes/fastpath";

// THREE-TIER ARCHITECTURE GRAPH (new default)
// Tier 0: Precheck (pattern matching) → fastpath or router
// Tier 1: Classifier (fast LLM) → direct (responder) or plan (planner)
// Tier 2: Planner (smart LLM) → multi-step execution
const redGraphBuilderThreeTier = new StateGraph(RedGraphState)
  .addNode("precheck", precheckNode)
  .addNode("fastpathExecutor", fastpathExecutorNode)
  .addNode("tinyConfirmer", tinyConfirmerNode)
  .addNode("classifier", classifierNode)
  .addNode("planner", plannerNode)
  .addNode("executor", executorNode)
  .addNode("search", searchNode)
  .addNode("scrape", scrapeNode)
  .addNode("command", commandNode)
  .addNode("responder", responderNode)
  // Start with precheck
  .addEdge("__start__", "precheck")
  // After precheck: fastpath or classifier
  .addConditionalEdges(
    "precheck",
    (state: RedGraphStateType) => {
      if (state.precheckDecision === 'fastpath') {
        return 'fastpath';
      }
      return 'classifier';
    },
    {
      "fastpath": "fastpathExecutor",
      "classifier": "classifier"
    }
  )
  // Fastpath: execute → confirm → END
  .addEdge("fastpathExecutor", "tinyConfirmer")
  .addEdge("tinyConfirmer", END)
  // After classifier: direct (responder) or plan (planner)
  .addConditionalEdges(
    "classifier",
    (state: RedGraphStateType) => {
      if (state.routerDecision === 'direct') {
        return 'responder';
      }
      return 'planner';
    },
    {
      "responder": "responder",
      "planner": "planner"
    }
  )
  // Planner → executor loop (existing planner architecture)
  .addConditionalEdges(
    "planner",
    (state: RedGraphStateType) => {
      if (state.requestReplan && state.replannedCount < 3) {
        return "executor";
      }
      return "executor";
    },
    {
      "executor": "executor"
    }
  )
  .addConditionalEdges(
    "executor",
    (state: RedGraphStateType) => {
      return state.nextGraph || "responder";
    },
    {
      "search": "search",
      "scrape": "scrape",
      "command": "command",
      "responder": "responder"
    }
  )
  // After specialized nodes, continue execution or end
  .addConditionalEdges(
    "search",
    (state: RedGraphStateType) => {
      if (state.nextGraph === 'search') {
        return 'search';
      }
      if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor';
      }
      return END;
    },
    {
      "search": "search",
      "executor": "executor",
      "__end__": END
    }
  )
  .addConditionalEdges(
    "scrape",
    (state: RedGraphStateType) => {
      if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor';
      }
      return END;
    },
    {
      "executor": "executor",
      "__end__": END
    }
  )
  .addConditionalEdges(
    "command",
    (state: RedGraphStateType) => {
      if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor';
      }
      return END;
    },
    {
      "executor": "executor",
      "__end__": END
    }
  )
  .addConditionalEdges(
    "responder",
    (state: RedGraphStateType) => {
      // Check if responder requested replanning
      if (state.requestReplan && state.replannedCount < 3) {
        return 'planner';
      }
      return END;
    },
    {
      "planner": "planner",
      "__end__": END
    }
  );

// PLANNER-BASED graph (kept for reference, but three-tier is now default)
const redGraphBuilderWithPlanner = new StateGraph(RedGraphState)
  .addNode("planner", plannerNode)      // Creates execution plan
  .addNode("executor", executorNode)    // Routes to appropriate step
  .addNode("search", searchNode)        // Web search node
  .addNode("scrape", scrapeNode)        // URL scraping node
  .addNode("command", commandNode)      // Command execution node
  .addNode("responder", responderNode)  // Final response generation node
  .addEdge("__start__", "planner")      // Always start with planner
  .addConditionalEdges(
    "planner",
    (state: RedGraphStateType) => {
      // After planning, check if replanning was requested
      if (state.requestReplan && state.replannedCount < 3) {
        // Exceeded max replans, go to executor anyway
        return "executor";
      }
      // Normal flow: go to executor to start executing plan
      return "executor";
    },
    {
      "executor": "executor"
    }
  )
  .addConditionalEdges(
    "executor",
    (state: RedGraphStateType) => {
      // Executor determines which specialized node to run based on current step
      return state.nextGraph || "responder";
    },
    {
      "search": "search",
      "scrape": "scrape",
      "command": "command",
      "responder": "responder"
    }
  )
  // After each specialized node, check if we need to continue execution or replan
  .addConditionalEdges(
    "search",
    (state: RedGraphStateType) => {
      // Legacy router mode support
      if (state.nextGraph === 'search') {
        return 'search';  // Old-style loop
      }
      
      // Check if we have more steps to execute
      if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor';  // Continue with next step
      }
      
      // Plan complete
      return END;
    },
    {
      "search": "search",      // Legacy loop
      "executor": "executor",  // Continue plan
      "__end__": END
    }
  )
  .addConditionalEdges(
    "scrape",
    (state: RedGraphStateType) => {
      // Check if we have more steps to execute
      if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor';
      }
      return END;
    },
    {
      "executor": "executor",
      "__end__": END
    }
  )
  .addConditionalEdges(
    "command",
    (state: RedGraphStateType) => {
      // Check if we have more steps to execute
      if (state.executionPlan && state.currentStepIndex < state.executionPlan.steps.length) {
        return 'executor';
      }
      return END;
    },
    {
      "executor": "executor",
      "__end__": END
    }
  )
  .addConditionalEdges(
    "responder",
    (state: RedGraphStateType) => {
      // Check if responder requested replanning
      if (state.requestReplan && state.replannedCount < 3) {
        return 'planner';  // Go back to planner for new plan
      }
      // Otherwise, we're done
      return END;
    },
    {
      "planner": "planner",
      "__end__": END
    }
  );

// LEGACY: Create ROUTER-BASED graph (old architecture, kept for backwards compatibility)
const redGraphBuilderWithRouter = new StateGraph(RedGraphState)
  .addNode("router", routerNode)
  .addNode("search", searchNode)
  .addNode("scrape", scrapeNode)
  .addNode("command", commandNode)
  .addNode("responder", responderNode)
  .addEdge("__start__", "router")
  .addConditionalEdges(
    "router",
    (state: RedGraphStateType) => {
      return state.nextGraph || "responder";
    },
    {
      "homeGraph": END,
      "assistantGraph": END,
      "search": "search",
      "scrape": "scrape",
      "command": "command",
      "responder": "responder",
    }
  )
  .addConditionalEdges(
    "search",
    (state: RedGraphStateType) => {
      if (state.nextGraph === 'search') {
        return 'search';
      }
      return 'responder';
    },
    {
      "search": "search",
      "responder": "responder"
    }
  )
  .addEdge("scrape", "responder")
  .addEdge("command", "responder")
  .addEdge("responder", END);

// Export THREE-TIER graph as default
export const redGraph = redGraphBuilderThreeTier.compile();

// Export PLANNER-BASED graph for reference
export const redGraphPlanner = redGraphBuilderWithPlanner.compile();

// Export ROUTER-BASED graph for backwards compatibility
export const redGraphLegacy = redGraphBuilderWithRouter.compile();
