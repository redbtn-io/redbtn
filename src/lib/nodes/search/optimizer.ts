/**
 * Search query optimizer
 * Uses LLM to optimize user queries into effective search terms
 */

import type { Red } from '../../..';
import { extractThinking } from '../../utils/thinking';
import { invokeWithRetry } from '../../utils/retry';
import { getNodeSystemPrefix } from '../../utils/node-helpers';

/**
 * Optimize a natural language query into effective search terms
 */
export async function optimizeSearchQuery(
  originalQuery: string,
  redInstance: Red,
  conversationId?: string,
  generationId?: string,
  nodeNumber: number = 2
): Promise<{ optimizedQuery: string; thinking?: string }> {
  const currentDate = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  const response = await invokeWithRetry(redInstance.chatModel, [
    {
      role: 'system',
      content: `${getNodeSystemPrefix(nodeNumber, 'Search Query Optimizer')}

Extract the key search terms from the user's prompt. Focus on:
- Core concepts and keywords
- Specific entities (names, places, products)
- Time-relevant terms (if asking about "latest" or "recent")
- Technical terms exactly as written

Return ONLY the optimized search query, nothing else.`
    },
    {
      role: 'user',
      content: originalQuery
    }
  ], { context: 'search query optimization' });
  
  const { thinking, cleanedContent } = extractThinking(response.content.toString());
  
  // Log optimization thinking if present
  if (thinking && generationId && conversationId) {
    await redInstance.logger.logThought({
      content: thinking,
      source: 'search-query-optimization',
      generationId,
      conversationId,
    });
  }
  
  return {
    optimizedQuery: cleanedContent.trim(),
    thinking: thinking || undefined,
  };
}

/**
 * Summarize search results into concise, relevant information
 */
export async function summarizeSearchResults(
  originalQuery: string,
  searchResults: string,
  redInstance: Red,
  conversationId?: string,
  generationId?: string,
  nodeNumber: number = 2
): Promise<{ summary: string; thinking?: string }> {
  const currentDate = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  const response = await invokeWithRetry(redInstance.chatModel, [
    {
      role: 'system',
      content: `${getNodeSystemPrefix(nodeNumber, 'Search Result Summarizer')}

You are an information extraction expert. Extract key facts and data to answer the user's query accurately and concisely. IMPORTANT: Do NOT repeat or rephrase the query - only provide the facts and information.`
    },
    {
      role: 'user',
      content: `User Query: ${originalQuery}\n\nSearch Results:\n${searchResults}\n\nExtract and summarize the key information that answers this query. Start directly with the facts - do NOT repeat the query:`
    }
  ], { context: 'search result summarization' });

  const { thinking, cleanedContent } = extractThinking(response.content.toString());
  
  // Log extraction thinking if present
  if (thinking && generationId && conversationId) {
    await redInstance.logger.logThought({
      content: thinking,
      source: 'search-result-extraction',
      generationId,
      conversationId,
    });
  }
  
  return {
    summary: cleanedContent.trim(),
    thinking: thinking || undefined,
  };
}
