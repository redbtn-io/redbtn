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

import { SystemMessage } from '@langchain/core/messages';
import type { Red } from '../../..';
import { createIntegratedPublisher } from '../../events/integrated-publisher';
import { invokeWithRetry } from '../../utils/retry';
import { getNodeSystemPrefix } from '../../utils/node-helpers';

interface SearchNodeState {
  query: { message: string };
  redInstance: Red;
  options?: {
    conversationId?: string;
    generationId?: string;
  };
  messageId?: string;
  toolParam?: string; // Optional override query from router or previous iteration
  searchIterations?: number; // Track loop count
  messages?: any[]; // Accumulated context and search results
  contextMessages?: any[]; // Pre-loaded context from router
  nodeNumber?: number; // Current node position in graph
}

const MAX_SEARCH_ITERATIONS = 5;

/**
 * Main search node function with iteration capability
 */
export async function searchNode(state: SearchNodeState): Promise<Partial<any>> {
  const startTime = Date.now();
  const redInstance: Red = state.redInstance;
  const userQuery = state.toolParam || state.query?.message || '';
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  const messageId = state.messageId;
  const messages = state.messages || [];
  const currentIteration = state.searchIterations || 0;
  const currentNodeNumber = state.nodeNumber || 2; // If not set, default to 2
  const nextNodeNumber = currentNodeNumber + 1; // Next node (responder) will be one more
  
  const maxResults = 10; // Google API limit is 10 results per query
  
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

  // Check if we've hit the iteration limit
  if (currentIteration >= MAX_SEARCH_ITERATIONS) {
    if (publisher) {
      await publisher.publishProgress(`🔍 Maximum search iterations (${MAX_SEARCH_ITERATIONS}) reached. Generating response with available information...`);
    }
    
    // Check if using planner mode
    const executionPlan = (state as any).executionPlan;
    const currentStepIndex = (state as any).currentStepIndex || 0;
    const usingPlanner = executionPlan && executionPlan.steps;
    
    if (usingPlanner) {
      // Planner mode: advance to next step
      return {
        messages: [
          ...messages,
          new SystemMessage(`Search completed after ${MAX_SEARCH_ITERATIONS} iterations. Use the information gathered to provide the best possible answer.`)
        ],
        searchIterations: currentIteration,
        currentStepIndex: currentStepIndex + 1,
        nextGraph: undefined,  // Clear nextGraph
        nodeNumber: nextNodeNumber
      };
    } else {
      // Router mode: go to responder
      return {
        messages: [
          ...messages,
          new SystemMessage(`Search completed after ${MAX_SEARCH_ITERATIONS} iterations. Use the information gathered to provide the best possible answer.`)
        ],
        searchIterations: currentIteration,
        nextGraph: 'responder',
        nodeNumber: nextNodeNumber
      };
    }
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
    // STEP 2: Call MCP web_search Tool
    // ==========================================
    const searchQuery = state.toolParam || userQuery;
    
    await redInstance.logger.log({
      level: 'info',
      category: 'tool',
      message: `� Searching for: "${searchQuery}"`,
      conversationId,
      generationId,
      metadata: { searchQuery },
    });

    if (publisher) {
      await publisher.publishProgress(`Searching web for: "${searchQuery}"`, {
        progress: 30,
      });
    }

    const searchResult = await redInstance.callMcpTool('web_search', {
      query: searchQuery,
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

      // Build proper context even when search fails
      const messages: any[] = [];
      
      // Add system message
      const systemMessage = `${getNodeSystemPrefix(currentNodeNumber, 'Search')}

The user asked about something but the search returned no results. Let them know you couldn't find information about their query.`;

      messages.push({ role: 'system', content: systemMessage });
      
      // Use pre-loaded context from router (no need to load again)
      if (state.contextMessages && state.contextMessages.length > 0) {
        // Filter out the current user message (will be re-added)
        const filteredMessages = state.contextMessages.filter((msg: any) => 
          !(msg.role === 'user' && msg.content === userQuery)
        );
        
        messages.push(...filteredMessages);
      }
      
      // Add user query with note about no results
      messages.push({
        role: 'user',
        content: `${userQuery}\n\n[Note: Web search returned no results for this query]`
      });

      return {
        messages,
        searchIterations: currentIteration + 1,
        nextGraph: 'responder',
        nodeNumber: nextNodeNumber
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
        searchQuery,
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
    const systemMessage = `${getNodeSystemPrefix(currentNodeNumber, 'Search')}

CRITICAL RULES:
1. Extract and present information from the search results directly and confidently
2. NEVER say "according to search results" or "I searched" - present facts naturally
3. If search results show game scores or results, state them clearly with the date
4. If no recent/current information is found, acknowledge this and suggest where to check
5. Be direct, helpful, and conversational
6. For time-sensitive queries (today, tonight, now), prioritize the most recent results`;

    messages.push({ role: 'system', content: systemMessage });
    
    // Use pre-loaded context from router (no need to load again)
    if (state.contextMessages && state.contextMessages.length > 0) {
      // Filter out the current user message (will be added with search results)
      const filteredMessages = state.contextMessages.filter((msg: any) => 
        !(msg.role === 'user' && msg.content === userQuery)
      );
      
      messages.push(...filteredMessages);
    }
    
    // Add the user's query with search results appended in brackets
    const userQueryWithResults = `${userQuery}\n\n[Search Results: ${searchResultText}]`;
    
    // Accumulate messages with search results
    const accumulatedMessages = [
      ...messages,
      {
        role: 'user',
        content: userQueryWithResults
      }
    ];

    // ==========================================
    // STEP 5: Evaluate if we have enough information
    // ==========================================
    if (publisher) {
      await publisher.publishProgress(`🤔 Evaluating if search results are sufficient (iteration ${currentIteration + 1}/${MAX_SEARCH_ITERATIONS})...`);
    }

    // Build evaluation context - include conversation history so evaluator understands references like "it", "them", etc.
    let conversationContext = '';
    if (messages.length > 1) {
      // Skip system message, include conversation history
      const contextMessages = messages.slice(1).map((msg: any) => {
        return `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`;
      }).join('\n');
      conversationContext = `\n\nConversation Context:\n${contextMessages}\n`;
    }

    const evaluationPrompt = `You are an AI search evaluator. Analyze the search results to determine if there is enough information to answer the user's query.
${conversationContext}
User Query: ${userQuery}

Search Results: ${searchResultText}

Current Iteration: ${currentIteration + 1} of ${MAX_SEARCH_ITERATIONS}

Evaluate:
1. Do the search results contain relevant information to answer the query?
2. Is the information complete enough for a satisfactory answer?
3. If not sufficient, what specific aspect should the next search focus on?

IMPORTANT: Consider the conversation context when evaluating. If the user says "search for it" or "what about them", use the conversation history to understand what they're referring to.

Respond with a JSON object:
{
  "sufficient": true/false,
  "reasoning": "Brief explanation of your decision",
  "newSearchQuery": "If not sufficient, provide a refined search query focusing on missing information"
}

Be practical: If results provide ANY useful information, consider it sufficient. Only request more searches if critical information is completely missing.`;

    const evaluationMessages = [
      { role: 'system', content: 'You are a search evaluator. Respond only with valid JSON.' },
      { role: 'user', content: evaluationPrompt }
    ];

    let evaluation: { sufficient: boolean; reasoning: string; newSearchQuery?: string };
    
    try {
      const evalResponse = await invokeWithRetry(redInstance.workerModel, evaluationMessages, {
        context: 'search result evaluation',
      });
      const evalContent = typeof evalResponse.content === 'string' 
        ? evalResponse.content 
        : JSON.stringify(evalResponse.content);
      
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = evalContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in evaluation response');
      }
      
      evaluation = JSON.parse(jsonMatch[0]);
      
      await redInstance.logger.log({
        level: 'info',
        category: 'node',
        message: `Search evaluation (iteration ${currentIteration + 1}): ${evaluation.sufficient ? 'SUFFICIENT' : 'INSUFFICIENT'}`,
        conversationId,
        generationId,
        metadata: {
          iteration: currentIteration + 1,
          sufficient: evaluation.sufficient,
          reasoning: evaluation.reasoning,
          newSearchQuery: evaluation.newSearchQuery
        }
      });

    } catch (error) {
      // If evaluation fails, assume sufficient and continue
      await redInstance.logger.log({
        level: 'warning',
        category: 'node',
        message: `Search evaluation failed, assuming sufficient: ${error}`,
        conversationId,
        generationId,
        metadata: { error: String(error) }
      });
      
      evaluation = {
        sufficient: true,
        reasoning: 'Evaluation failed, proceeding with available results'
      };
    }

    // ==========================================
    // STEP 6: Decide next action based on evaluation
    // ==========================================
    
    // Check if we're using planner-based execution
    const executionPlan = (state as any).executionPlan;
    const currentStepIndex = (state as any).currentStepIndex || 0;
    const usingPlanner = executionPlan && executionPlan.steps;
    
    await redInstance.logger.log({
      level: 'info',
      category: 'search',
      message: `🔍 Search decision point - sufficient: ${evaluation.sufficient}, usingPlanner: ${!!usingPlanner}, currentStepIndex: ${currentStepIndex}, iteration: ${currentIteration + 1}`,
      conversationId,
      generationId,
      metadata: { 
        sufficient: evaluation.sufficient,
        usingPlanner: !!usingPlanner,
        currentStepIndex,
        iteration: currentIteration + 1,
        hasExecutionPlan: !!executionPlan,
        executionPlanSteps: executionPlan?.steps?.length
      }
    });
    
    if (evaluation.sufficient) {
      // We have enough info - advance to next step in plan
      if (publisher) {
        await publisher.publishProgress(`✓ Found sufficient information after ${currentIteration + 1} iteration(s)`);
      }
      
      if (usingPlanner) {
        // Advance to next step in execution plan
        await redInstance.logger.log({
          level: 'info',
          category: 'search',
          message: `✅ PLANNER MODE: Advancing to next step (${currentStepIndex} → ${currentStepIndex + 1})`,
          conversationId,
          generationId
        });
        
        return {
          messages: accumulatedMessages,
          searchIterations: currentIteration + 1,
          currentStepIndex: currentStepIndex + 1,  // Move to next step
          nextGraph: undefined,  // CRITICAL: Clear nextGraph to prevent conditional edge from looping
          nodeNumber: nextNodeNumber
        };
      } else {
        // Legacy router mode - go to responder
        await redInstance.logger.log({
          level: 'info',
          category: 'search',
          message: `✅ ROUTER MODE: Going to responder`,
          conversationId,
          generationId
        });
        
        return {
          messages: accumulatedMessages,
          searchIterations: currentIteration + 1,
          nextGraph: 'responder',
          nodeNumber: nextNodeNumber
        };
      }
      
    } else if (currentIteration + 1 < MAX_SEARCH_ITERATIONS && evaluation.newSearchQuery) {
      // Need more info - inject another search step into the plan
      if (publisher) {
        await publisher.publishProgress(`🔄 Insufficient info. Refining search: "${evaluation.newSearchQuery}"`);
      }
      
      if (usingPlanner) {
        // Inject a new search step RIGHT AFTER current step
        const updatedPlan = { ...executionPlan };
        const newSearchStep = {
          type: 'search' as const,
          purpose: `Refined search: ${evaluation.reasoning}`,
          searchQuery: evaluation.newSearchQuery
        };
        
        // Insert new search step after current position
        updatedPlan.steps = [
          ...updatedPlan.steps.slice(0, currentStepIndex + 1),
          newSearchStep,
          ...updatedPlan.steps.slice(currentStepIndex + 1)
        ];
        
        await redInstance.logger.log({
          level: 'info',
          category: 'search',
          message: `<yellow>🔄 Injecting additional search step into plan</yellow>`,
          conversationId,
          generationId,
          metadata: { newSearchStep }
        });
        
        return {
          messages: accumulatedMessages,
          searchIterations: currentIteration + 1,
          executionPlan: updatedPlan,  // Update plan with new step
          currentStepIndex: currentStepIndex + 1,  // Move to the injected search step
          nextGraph: undefined,  // CRITICAL: Clear nextGraph to prevent looping
          nodeNumber: nextNodeNumber
        };
      } else {
        // Legacy router mode - loop back
        return {
          messages: accumulatedMessages,
          searchIterations: currentIteration + 1,
          toolParam: evaluation.newSearchQuery,
          nextGraph: 'search',
          nodeNumber: nextNodeNumber
        };
      }
      
    } else {
      // Hit limit or no new query - proceed with what we have
      if (publisher) {
        await publisher.publishProgress(`⚠️ Proceeding with available information`);
      }
      
      if (usingPlanner) {
        // Advance to next step
        return {
          messages: accumulatedMessages,
          searchIterations: currentIteration + 1,
          currentStepIndex: currentStepIndex + 1,
          nextGraph: undefined,  // CRITICAL: Clear nextGraph
          nodeNumber: nextNodeNumber
        };
      } else {
        // Legacy router mode
        return {
          messages: accumulatedMessages,
          searchIterations: currentIteration + 1,
          nextGraph: 'responder',
          nodeNumber: nextNodeNumber
        };
      }
    }

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
      searchIterations: currentIteration + 1,
      nextGraph: 'responder',
      nodeNumber: nextNodeNumber
    };
  }
}
