import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { InvokeOptions } from '../../index';
import { routerNode } from "../nodes/router";
import { responderNode } from "../nodes/responder";
import { searchNode } from "../nodes/search";
import { scrapeNode } from "../nodes/scrape";
import { commandNode } from "../nodes/command";

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
  nextGraph: Annotation<'homeGraph' | 'assistantGraph' | 'responder' | 'search' | 'scrape' | 'command'>({
    reducer: (x: 'homeGraph' | 'assistantGraph' | 'responder' | 'search' | 'scrape' | 'command', y: 'homeGraph' | 'assistantGraph' | 'responder' | 'search' | 'scrape' | 'command') => y
  }),
  // messageId for linking to Redis pub/sub and event publishing
  messageId: Annotation<string | undefined>({
    reducer: (x: string | undefined, y: string | undefined) => y
  })
});

type RedGraphStateType = typeof RedGraphState.State;

// --- Graph Definition ---

// Create a new graph instance
const redGraphBuilder = new StateGraph(RedGraphState)
  .addNode("router", routerNode)
  .addNode("search", searchNode)     // Web search node
  .addNode("scrape", scrapeNode)     // URL scraping node
  .addNode("command", commandNode)   // Command execution node
  .addNode("responder", responderNode) // Final response generation node
  .addEdge("__start__", "router")
  .addConditionalEdges(
    "router",
    (state: RedGraphStateType) => state.nextGraph || "responder",
    {
      "homeGraph": END,
      "assistantGraph": END,
      "search": "search",     // Route to search when web search needed
      "scrape": "scrape",     // Route to scrape when URL scraping needed
      "command": "command",   // Route to command when system command needed
      "responder": "responder", // Route directly to responder for conversation
    }
  )
  // After tool nodes execute, go to responder with built context
  .addEdge("search", "responder")
  .addEdge("scrape", "responder")
  .addEdge("command", "responder")
  // Responder is the final node - always end after generating response
  .addEdge("responder", END);

// Compile the graph into a runnable object
export const redGraph = redGraphBuilder.compile();
