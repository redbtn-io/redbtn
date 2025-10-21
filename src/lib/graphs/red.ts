import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { InvokeOptions } from '../../index';
import { routerNode } from "../nodes/router";
import { chatNode } from "../nodes/chat";
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
  nextGraph: Annotation<'homeGraph' | 'assistantGraph' | 'chat' | 'search' | 'scrape' | 'command'>({
    reducer: (x: 'homeGraph' | 'assistantGraph' | 'chat' | 'search' | 'scrape' | 'command', y: 'homeGraph' | 'assistantGraph' | 'chat' | 'search' | 'scrape' | 'command') => y
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
  .addNode("chat", chatNode)
  .addEdge("__start__", "router")
  .addConditionalEdges(
    "router",
    (state: RedGraphStateType) => state.nextGraph || "chat",
    {
      "homeGraph": END,
      "assistantGraph": END,
      "search": "search",     // Route to search when web search needed
      "scrape": "scrape",     // Route to scrape when URL scraping needed
      "command": "command",   // Route to command when system command needed
      "chat": "chat",         // Route directly to chat for conversation
    }
  )
  // After tool nodes execute, go to chat with results
  .addEdge("search", "chat")
  .addEdge("scrape", "chat")
  .addEdge("command", "chat")
  // Chat is the final node - always end after generating response
  .addEdge("chat", END);

// Compile the graph into a runnable object
export const redGraph = redGraphBuilder.compile();
