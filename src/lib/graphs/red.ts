import { StateGraph, Annotation, END } from "@langchain/langgraph";
import { InvokeOptions } from '../../index';
import { routerNode } from "../nodes/router";
import { chatNode } from "../nodes/chat";
import { toolNode } from "../nodes/tool";
import { toolPickerNode } from "../nodes/toolPicker";

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
  nextGraph: Annotation<'homeGraph' | 'assistantGraph' | 'chat' | 'toolPicker'>({
    reducer: (x: 'homeGraph' | 'assistantGraph' | 'chat' | 'toolPicker', y: 'homeGraph' | 'assistantGraph' | 'chat' | 'toolPicker') => y
  }),
  // Track which tools were selected by toolPicker for this query
  selectedTools: Annotation<string[]>({
    reducer: (x: string[], y: string[]) => y,
    default: () => []
  })
});

type RedGraphStateType = typeof RedGraphState.State;

// --- Graph Definition ---

// Helper function to determine if we should continue to tools or end
function shouldContinue(state: RedGraphStateType): "tools" | typeof END {
  const toolCalls = state.response?.tool_calls;
  
  // If the LLM makes tool calls, route to the tools node for execution
  if (toolCalls && toolCalls.length > 0) {
    return "tools";
  }
  
  // Otherwise, end the graph (no tools to execute)
  return END;
}

// Create a new graph instance
const redGraphBuilder = new StateGraph(RedGraphState)
  .addNode("router", routerNode)
  .addNode("toolPicker", toolPickerNode) // Pre-filter and execute tools if needed
  .addNode("chat", chatNode)
  .addNode("tools", toolNode) // For follow-up tool calls from chat
  .addEdge("__start__", "router")
  .addConditionalEdges(
    "router",
    (state: RedGraphStateType) => state.nextGraph || "chat",
    {
      "homeGraph": END,
      "assistantGraph": END,
      "toolPicker": "toolPicker", // Route to toolPicker when action needed
      "chat": "chat", // Route directly to chat for conversation
    }
  )
  // After toolPicker executes tools, go to chat with results
  .addEdge("toolPicker", "chat")
  // After chat, check if we need to call MORE tools (for follow-ups)
  .addConditionalEdges("chat", shouldContinue, {
    tools: "tools",
    [END]: END
  })
  // After follow-up tools, go back to chat to process results
  .addEdge("tools", "chat");

// Compile the graph into a runnable object
export const redGraph = redGraphBuilder.compile();
