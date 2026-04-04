/**
 * Search query optimizer
 * Uses LLM to optimize user queries into effective search terms
 */
import type { Red } from '../../..';
/**
 * Optimize a natural language query into effective search terms
 */
export declare function optimizeSearchQuery(originalQuery: string, redInstance: Red, conversationId?: string, generationId?: string, nodeNumber?: number): Promise<{
    optimizedQuery: string;
    thinking?: string;
}>;
/**
 * Summarize search results into concise, relevant information
 */
export declare function summarizeSearchResults(originalQuery: string, searchResults: string, redInstance: Red, conversationId?: string, generationId?: string, nodeNumber?: number): Promise<{
    summary: string;
    thinking?: string;
}>;
