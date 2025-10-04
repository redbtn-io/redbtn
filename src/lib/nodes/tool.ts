import { ToolNode } from "@langchain/langgraph/prebuilt";
import { allTools } from "../tools";

/**
 * Tool execution node using LangGraph's built-in ToolNode
 * Automatically handles tool execution based on tool_calls from the LLM
 */
export const toolNode = new ToolNode(allTools as any);
