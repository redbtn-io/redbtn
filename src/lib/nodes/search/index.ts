/**
 * Web Search Node
 * 
 * Executes web searches via MCP with detailed real-time progress events:
 * 1. Optimizes the search query using LLM
 * 2. Calls web_search MCP tool (Google Custom Search API)
 * 3. Returns context for chat node
 * 
 * Note: This node now uses the MCP (Model Context Protocol) web server
 * instead of direct API calls for better architecture and reusability.
 */

import { SystemMessage } from '@langchain/core/messages';
import type { Red } from '../../..';
import { createIntegratedPublisher } from '../../events/integrated-publisher';
import { optimizeSearchQuery } from './optimizer';

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
  const userQuery = state.toolParam || state.query?.message || '';
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  const messageId = state.messageId;
  
  const maxResults = 10;
  
  // Create event publisher for real-time updates
  let publisher: any = null;
  if (redInstance?.messageQueue && messageId && conversationId) {
    publisher = createIntegratedPublisher(
      redInstance.messageQueue,
      'search', // Changed from 'web_search' to match frontend expectations
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
      message: `🔍 Starting web search via MCP`,
      conversationId,
      generationId,
      metadata: { 
        toolName: 'web_search',
        query: userQuery,
        maxResults,
        protocol: 'MCP/JSON-RPC 2.0'
      },
    });

    if (publisher) {
      await publisher.publishStart({
        input: { query: userQuery, maxResults },
        expectedDuration: 8000, // ~8 seconds for MCP call
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
      await publisher.publishProgress(`Searching web for: "${optimizedQuery}"`, {
        progress: 30,
        data: { optimizedQuery },
      });
    }

    // ==========================================
    // STEP 3: Call MCP web_search Tool
    // ==========================================
    const searchResult = await redInstance.callMcpTool('web_search', {
      query: optimizedQuery,
      count: maxResults
    }, {
      conversationId,
      generationId,
      messageId
    });

    // Check for errors
    if (searchResult.isError) {
      throw new Error(searchResult.content[0]?.text || 'Search failed');
    }

    const searchResultText = searchResult.content[0]?.text || '';

    if (!searchResultText || searchResultText.includes('No results found')) {
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

    const duration = Date.now() - startTime;

    await redInstance.logger.log({
      level: 'success',
      category: 'tool',
      message: `✓ Web search completed via MCP in ${(duration / 1000).toFixed(1)}s`,
      conversationId,
      generationId,
      metadata: { 
        duration,
        resultLength: searchResultText.length,
        optimizedQuery,
        protocol: 'MCP/JSON-RPC 2.0'
      },
    });

    if (publisher) {
      await publisher.publishComplete({
        result: searchResultText,
        metadata: {
          duration,
          resultLength: searchResultText.length,
          protocol: 'MCP',
        },
      });
    }

    // ==========================================
    // STEP 4: Build Context with Search Results
    // ==========================================
    // Load conversation context via Context MCP
    const messages: any[] = [];
    
    // Add system message
    const systemMessage = `You are Red, an AI assistant developed by redbtn.io.
Current date: ${new Date().toLocaleDateString()}

CRITICAL RULES:
1. Use the search results provided to answer the user's query directly and confidently
2. NEVER say "according to search results" or reference that you searched
3. Answer as if you know this information naturally
4. Be direct, helpful, and conversational`;

    messages.push({ role: 'system', content: systemMessage });
    
    // Load conversation context if we have one
    if (conversationId) {
      const contextResult = await redInstance.callMcpTool(
        'get_context_history',
        {
          conversationId,
          maxTokens: 25000, // Leave room for search results
          includeSummary: true,
          summaryType: 'trailing',
          format: 'llm'
        },
        { conversationId, generationId, messageId }
      );

      if (!contextResult.isError && contextResult.content?.[0]?.text) {
        const contextData = JSON.parse(contextResult.content[0].text);
        const contextMessages = contextData.messages || [];
        
        // Filter out the current user message (will be added with search results)
        const filteredMessages = contextMessages.filter((msg: any) => 
          !(msg.role === 'user' && msg.content === userQuery)
        );
        
        messages.push(...filteredMessages);
      }
    }
    
    // Add the user's query with search results appended in brackets
    const userQueryWithResults = `${userQuery}\n\n[Search Results: ${searchResultText}]`;
    messages.push({
      role: 'user',
      content: userQueryWithResults
    });

    return {
      messages,
      nextGraph: 'responder',
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
        duration,
        query: userQuery
      },
    });

    if (publisher) {
      await publisher.publishError(errorMessage);
    }

    // Return error context but continue to responder
    return {
      messages: [
        {
          role: 'system',
          content: `You are Red, an AI assistant. The web search failed with error: ${errorMessage}. Inform the user and try to help with existing knowledge.`
        },
        {
          role: 'user',
          content: userQuery
        }
      ],
      nextGraph: 'responder',
    };
  }
}
