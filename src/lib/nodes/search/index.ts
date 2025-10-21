/**
 * Web Search Node
 * 
 * Executes web searches with detailed real-time progress events:
 * 1. Optimizes the search query using LLM
 * 2. Searches Google Custom Search API
 * 3. Scrapes content from top results
 * 4. Extracts and summarizes relevant information
 * 5. Returns context for chat node
 */

import { SystemMessage } from '@langchain/core/messages';
import type { Red } from '../../..';
import { createIntegratedPublisher } from '../../events/integrated-publisher';
import { searchGoogle } from './google';
import { scrapeSearchResults } from './scraper';
import { optimizeSearchQuery, summarizeSearchResults } from './optimizer';
import type { SearchResult } from './types';

interface SearchNodeState {
  query: { message: string };
  redInstance: Red;
  options?: {
    conversationId?: string;
    generationId?: string;
  };
  messageId?: string;
  toolParam?: string; // Optional override query
}

/**
 * Main search node function
 */
export async function searchNode(state: SearchNodeState): Promise<Partial<any>> {
  const startTime = Date.now();
  const redInstance: Red = state.redInstance;
  const userQuery = state.query?.message || '';
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  const messageId = state.messageId;
  
  const maxResults = 10;
  
  // Create event publisher for real-time updates
  let publisher: any = null;
  if (redInstance?.messageQueue && messageId && conversationId) {
    publisher = createIntegratedPublisher(
      redInstance.messageQueue,
      'web_search',
      'Web Search',
      messageId,
      conversationId
    );
  }

  try {
    // ==========================================
    // STEP 1: Start & Log
    // ==========================================
    await redInstance.logger.log({
      level: 'info',
      category: 'tool',
      message: `🔍 Starting web search`,
      conversationId,
      generationId,
      metadata: { 
        toolName: 'web_search',
        query: userQuery,
        maxResults 
      },
    });

    if (publisher) {
      await publisher.publishStart({
        input: { query: userQuery, maxResults },
        expectedDuration: 12000, // ~12 seconds for full search + scrape
      });
    }

    // ==========================================
    // STEP 2: Optimize Search Query
    // ==========================================
    if (publisher) {
      await publisher.publishProgress('Optimizing search query...', { progress: 10 });
    }

    const { optimizedQuery } = await optimizeSearchQuery(
      userQuery,
      redInstance,
      conversationId,
      generationId
    );

    await redInstance.logger.log({
      level: 'info',
      category: 'tool',
      message: `📝 Query optimized: "${userQuery.substring(0, 40)}..." → "${optimizedQuery}"`,
      conversationId,
      generationId,
      metadata: { 
        originalQuery: userQuery,
        optimizedQuery 
      },
    });

    if (publisher) {
      await publisher.publishProgress(`Searching Google for: "${optimizedQuery}"`, {
        progress: 20,
        data: { optimizedQuery },
      });
    }

    // ==========================================
    // STEP 3: Search Google
    // ==========================================
    const searchResults = await searchGoogle(optimizedQuery, maxResults);

    if (searchResults.length === 0) {
      await redInstance.logger.log({
        level: 'warn',
        category: 'tool',
        message: `⚠️ No search results found`,
        conversationId,
        generationId,
      });

      if (publisher) {
        await publisher.publishComplete({
          result: 'No results found',
          metadata: { resultsCount: 0 },
        });
      }

      return {
        messages: [
          new SystemMessage(`[INTERNAL CONTEXT]\nNo search results found for: ${optimizedQuery}`)
        ],
        nextGraph: 'chat',
      };
    }

    await redInstance.logger.log({
      level: 'success',
      category: 'tool',
      message: `✓ Found ${searchResults.length} search results`,
      conversationId,
      generationId,
      metadata: { 
        resultsCount: searchResults.length,
        topResult: searchResults[0]?.title 
      },
    });

    if (publisher) {
      await publisher.publishProgress(`Found ${searchResults.length} results, extracting content...`, {
        progress: 40,
        data: { 
          resultsCount: searchResults.length,
          topResults: searchResults.slice(0, 3).map(r => r.title),
        },
      });
    }

    // ==========================================
    // STEP 4: Scrape Result Pages
    // ==========================================
    const scrapedResults = await scrapeSearchResults(
      searchResults,
      (current, total, url) => {
        const progress = 40 + Math.floor((current / total) * 40); // 40-80%
        
        if (publisher) {
          publisher.publishProgress(`Reading page ${current}/${total}: ${new URL(url).hostname}`, {
            progress,
            data: { 
              currentPage: current,
              totalPages: total,
              url: new URL(url).hostname,
            },
          });
        }
      }
    );

    const successfulScrapes = scrapedResults.filter(r => r.content).length;

    await redInstance.logger.log({
      level: 'success',
      category: 'tool',
      message: `✓ Extracted content from ${successfulScrapes}/${searchResults.length} pages`,
      conversationId,
      generationId,
      metadata: { 
        successfulScrapes,
        totalResults: searchResults.length 
      },
    });

    if (publisher) {
      await publisher.publishProgress(`Analyzing content from ${successfulScrapes} pages...`, {
        progress: 85,
        data: { successfulScrapes },
      });
    }

    // ==========================================
    // STEP 5: Build Combined Results Text
    // ==========================================
    const combinedResults = scrapedResults
      .map((result, index) => {
        const parts = [
          `[Result ${index + 1}]`,
          `Title: ${result.title}`,
          `URL: ${result.url}`,
          `Snippet: ${result.snippet}`,
        ];
        
        if (result.content) {
          parts.push(`Content:\n${result.content}`);
        }
        
        return parts.join('\n');
      })
      .join('\n\n---\n\n');

    // ==========================================
    // STEP 6: Extract & Summarize Key Info
    // ==========================================
    const { summary } = await summarizeSearchResults(
      userQuery,
      combinedResults,
      redInstance,
      conversationId,
      generationId
    );

    const duration = Date.now() - startTime;

    await redInstance.logger.log({
      level: 'success',
      category: 'tool',
      message: `✓ Web search completed in ${(duration / 1000).toFixed(1)}s`,
      conversationId,
      generationId,
      metadata: { 
        duration,
        summaryLength: summary.length,
        resultsCount: searchResults.length,
        scrapedCount: successfulScrapes,
      },
    });

    if (publisher) {
      await publisher.publishComplete({
        result: summary,
        metadata: {
          duration,
          resultsCount: searchResults.length,
          scrapedCount: successfulScrapes,
          summaryLength: summary.length,
        },
      });
    }

    // ==========================================
    // STEP 7: Return Context for Chat
    // ==========================================
    return {
      messages: [
        new SystemMessage(
          `[INTERNAL CONTEXT - User cannot see this]\n` +
          `Relevant information found:\n\n${summary}\n\n` +
          `Use this information to answer the user's query directly and confidently. ` +
          `Do not say "according to search results" or reference external sources - ` +
          `answer as if you know this information.`
        )
      ],
      nextGraph: 'chat',
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const duration = Date.now() - startTime;
    
    await redInstance.logger.log({
      level: 'error',
      category: 'tool',
      message: `✗ Web search failed: ${errorMessage}`,
      conversationId,
      generationId,
      metadata: { 
        error: errorMessage,
        duration 
      },
    });

    if (publisher) {
      await publisher.publishError({
        error: errorMessage,
      });
    }

    // Return error context but continue to chat
    return {
      messages: [
        new SystemMessage(
          `[INTERNAL CONTEXT]\n` +
          `Web search failed: ${errorMessage}\n` +
          `Inform the user and try to help with existing knowledge.`
        )
      ],
      nextGraph: 'chat',
    };
  }
}
