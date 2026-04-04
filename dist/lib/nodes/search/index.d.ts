/**
 * Web Search Node with Iterative Searching
 *
 * Executes web searches via MCP with intelligent iteration:
 * 1. Performs web search
 * 2. Evaluates if results are sufficient to answer the query
 * 3. If not sufficient, generates new search query and loops (up to 5 times)
 * 4. When sufficient info gathered, passes context to responder for streaming response
 *
 * Note: This node can loop back to itself via nextGraph='search'
 */
import type { Red } from '../../..';
interface SearchNodeState {
    query: {
        message: string;
    };
    redInstance: Red;
    options?: {
        conversationId?: string;
        generationId?: string;
    };
    messageId?: string;
    toolParam?: string;
    searchIterations?: number;
    messages?: any[];
    contextMessages?: any[];
    nodeNumber?: number;
}
/**
 * Main search node function with iteration capability
 */
export declare function searchNode(state: SearchNodeState): Promise<Partial<any>>;
export {};
