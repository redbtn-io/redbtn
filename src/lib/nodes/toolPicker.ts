import { Red } from '../..';
import { allTools } from '../tools';
import { SystemMessage } from '@langchain/core/messages';

/**
 * The toolPicker node executes web_search tool before routing to chat.
 * This provides the chat node with fresh context without exposing tools
 * to conversational queries, preserving streaming.
 * 
 * @param state The current state of the graph.
 * @returns A partial state with tool results added to messages.
 */
export async function toolPickerNode(state: any): Promise<Partial<any>> {
  const query = state.query?.message || '';
  const redInstance: Red = state.redInstance;
  const conversationId = state.options?.conversationId;

  try {
    console.log('[ToolPicker] Executing web_search for:', query.substring(0, 60) + '...');
    
    // Get executive summary for context (if exists)
    let executiveSummary = '';
    if (conversationId) {
      const summary = await redInstance.memory.getExecutiveSummary(conversationId);
      if (summary) {
        executiveSummary = `\n\n[Conversation Context]\n${summary}\n`;
        console.log('[ToolPicker] Including executive summary in search context');
      }
    }
    
    // Find and execute web_search tool with the user's query + context
    const webSearchTool = allTools.find(t => t.name === 'web_search');
    
    if (!webSearchTool) {
      console.error('[ToolPicker] web_search tool not found');
      return { selectedTools: [], messages: [] };
    }

    // Build enhanced query with context
    const enhancedQuery = executiveSummary 
      ? `${query}${executiveSummary}`
      : query;

    const result = await webSearchTool.invoke({ query: enhancedQuery });
    
    // Check if search results are relevant using LLM
    console.log('[ToolPicker] Validating search result relevance...');
    const relevanceCheck = await redInstance.localModel.invoke([
      {
        role: 'system',
        content: 'You are a search quality evaluator. Determine if the search results provide useful information to answer the user query. Reply with ONLY "RELEVANT" or "NOT_RELEVANT".'
      },
      {
        role: 'user',
        content: `User Query: ${query}\n\nSearch Results:\n${result}\n\nAre these results relevant and useful for answering the query?`
      }
    ]);
    
    const relevanceResponse = relevanceCheck.content.toString().trim().toUpperCase();
    const isRelevant = relevanceResponse.includes('RELEVANT') && !relevanceResponse.includes('NOT_RELEVANT');
    
    if (!isRelevant) {
      console.log('[ToolPicker] Search results deemed not relevant - falling back to direct answer');
      return { 
        selectedTools: ['web_search'], 
        messages: [
          new SystemMessage(`[Web Search Note]\nSearch was performed but results were not relevant to the query. Answer based on your knowledge instead.`)
        ] 
      };
    }
    
    console.log('[ToolPicker] Search results validated as relevant');
    
    // Add tool result as a SystemMessage (proper LangChain message type)
    return {
      selectedTools: ['web_search'],
      messages: [
        new SystemMessage(`[Web Search Results]\n${result}\n\nUse this information to answer the user's query.`)
      ]
    };

  } catch (error) {
    console.error('[ToolPicker] Error executing tool:', error);
    return { selectedTools: [], messages: [] };
  }
}
