/**
 * Search query optimizer
 * Uses LLM to optimize user queries into effective search terms
 */

import type { Red } from '../../..';
import { extractThinking } from '../../utils/thinking';

/**
 * Optimize a natural language query into effective search terms
 */
export async function optimizeSearchQuery(
  originalQuery: string,
  redInstance: Red,
  conversationId?: string,
  generationId?: string
): Promise<{ optimizedQuery: string; thinking?: string }> {
  const currentDate = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  const response = await redInstance.chatModel.invoke([
    {
      role: 'system',
      content: `You are a search query optimizer for an AI assistant named Red.
Today's date: ${currentDate}. 

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
  ]);
  
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
  generationId?: string
): Promise<{ summary: string; thinking?: string }> {
  const currentDate = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  const response = await redInstance.chatModel.invoke([
    {
      role: 'system',
      content: `Today's date: ${currentDate}. You are an information extraction expert. Extract key facts and data to answer the user's query accurately and concisely. IMPORTANT: Do NOT repeat or rephrase the query - only provide the facts and information.`
    },
    {
      role: 'user',
      content: `User Query: ${originalQuery}\n\nSearch Results:\n${searchResults}\n\nExtract and summarize the key information that answers this query. Start directly with the facts - do NOT repeat the query:`
    }
  ]);

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
