import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { InvokeOptions } from '../../index';
import { routerNode } from "../nodes/router";
import { chatNode } from "../nodes/chat";

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
  response: Annotation<string>({
    reducer: (x: string, y: string) => y
  }),
  nextGraph: Annotation<'homeGraph' | 'assistantGraph' | 'chat'>({
    reducer: (x: 'homeGraph' | 'assistantGraph' | 'chat', y: 'homeGraph' | 'assistantGraph' | 'chat') => y
  })
});

type RedGraphStateType = typeof RedGraphState.State;

// --- Graph Definition ---

// Create a new graph instance
const redGraphBuilder = new StateGraph(RedGraphState)
  .addNode("router", routerNode)
  .addNode("chat", chatNode)
  .addEdge("__start__", "router")
  .addConditionalEdges(
    "router",
    (state: RedGraphStateType) => state.nextGraph || "chat",
    {
      "homeGraph": END,
      "assistantGraph": END,
      "chat": "chat",
    }
  )
  .addEdge("chat", "__end__");

// Compile the graph into a runnable object
export const redGraph = redGraphBuilder.compile();
