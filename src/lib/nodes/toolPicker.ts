import { Red } from '../..';
import { allTools } from '../tools';
import { SystemMessage } from '@langchain/core/messages';
import { extractThinking, logThinking } from '../utils/thinking';

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
  const toolAction = state.toolAction || 'web_search';
  const toolParam = state.toolParam || '';
  const generationId = state.options?.generationId;
  const conversationId = state.options?.conversationId;

  try {
    // Log tool execution start
    const toolEmojis: Record<string, string> = {
      'web_search': '🔍',
      'scrape_url': '📄',
      'system_command': '⚙️',
    };
    const emoji = toolEmojis[toolAction] || '🔧';
    
    await redInstance.logger.log({
      level: 'info',
      category: 'tool',
      message: `<yellow>${emoji} Executing tool:</yellow> <bold>${toolAction}</bold>`,
      generationId,
      conversationId,
      metadata: { tool: toolAction, param: toolParam },
    });
    
    let result = '';
    let toolUsed = toolAction;
    let searchQuery = query; // Default to original query
    
    // For web_search, let LLM optimize the search terms
    if (toolAction === 'web_search') {
      await redInstance.logger.log({
        level: 'debug',
        category: 'tool',
        message: `<dim>Optimizing search query...</dim>`,
        generationId,
        conversationId,
      });
      
      const currentDate = new Date().toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
      
      const searchOptimization = await redInstance.localModel.invoke([
        {
          role: 'system',
          content: `You are a search query optimizer for an Artificial Intelligence named Red.
          Today's date: ${currentDate}. 
          
          Extract the key search terms from the user's prompt. 

          Return ONLY the optimized search query, nothing else.`
        },
        {
          role: 'user',
          content: query
        }
      ]);
      
      const { thinking, cleanedContent } = extractThinking(searchOptimization.content.toString());
      
      // Log optimization thinking
      if (thinking && generationId && conversationId) {
        await redInstance.logger.logThought({
          content: thinking,
          source: 'toolPicker-search-optimization',
          generationId,
          conversationId,
        });
      }
      
      logThinking(thinking, 'ToolPicker (Search Optimization)');
      searchQuery = cleanedContent.trim();
      
      await redInstance.logger.log({
        level: 'info',
        category: 'tool',
        message: `<cyan>Optimized search:</cyan> <dim>"${query.substring(0, 40)}${query.length > 40 ? '...' : ''}"</dim> → <green>"${searchQuery}"</green>`,
        generationId,
        conversationId,
        metadata: { originalQuery: query, optimizedQuery: searchQuery },
      });
    }
    
    // Execute the specific tool the router chose
    if (toolAction === 'web_search') {
      const webSearchTool = allTools.find(t => t.name === 'web_search');
      if (!webSearchTool) {
        await redInstance.logger.log({
          level: 'error',
          category: 'tool',
          message: `<red>✗ Tool not found:</red> web_search`,
          generationId,
          conversationId,
        });
        return { selectedTools: [], messages: [], toolStatus: 'error: tool not found' };
      }
      result = await webSearchTool.invoke({ query: searchQuery });
      
    } else if (toolAction === 'scrape_url') {
      const scrapeTool = allTools.find(t => t.name === 'scrape_url');
      if (!scrapeTool) {
        await redInstance.logger.log({
          level: 'error',
          category: 'tool',
          message: `<red>✗ Tool not found:</red> scrape_url`,
          generationId,
          conversationId,
        });
        return { selectedTools: [], messages: [], toolStatus: 'error: tool not found' };
      }
      const urlToScrape = toolParam || query;
      await redInstance.logger.log({
        level: 'debug',
        category: 'tool',
        message: `<dim>Scraping URL: ${urlToScrape}</dim>`,
        generationId,
        conversationId,
      });
      result = await scrapeTool.invoke({ url: urlToScrape });
      
    } else if (toolAction === 'system_command') {
      const commandTool = allTools.find(t => t.name === 'send_command');
      if (!commandTool) {
        await redInstance.logger.log({
          level: 'error',
          category: 'tool',
          message: `<red>✗ Tool not found:</red> send_command`,
          generationId,
          conversationId,
        });
        return { selectedTools: [], messages: [], toolStatus: 'error: tool not found' };
      }
      const command = toolParam || query;
      await redInstance.logger.log({
        level: 'debug',
        category: 'tool',
        message: `<dim>Executing command: ${command}</dim>`,
        generationId,
        conversationId,
      });
      result = await commandTool.invoke({ command });
    }
    
    // Log tool completion
    await redInstance.logger.log({
      level: 'success',
      category: 'tool',
      message: `<green>✓ Tool completed:</green> <bold>${toolAction}</bold> <dim>(${result.length} chars)</dim>`,
      generationId,
      conversationId,
      metadata: { tool: toolAction, resultLength: result.length },
    });
    
    // Extract and summarize the information
    await redInstance.logger.log({
      level: 'debug',
      category: 'tool',
      message: `<dim>Extracting key information...</dim>`,
      generationId,
      conversationId,
    });
    const currentDate = new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    
    const extractedInfo = await redInstance.localModel.invoke([
      {
        role: 'system',
        content: `Today's date: ${currentDate}. You are an information extraction expert. Extract key facts and data to answer the user's query accurately and concisely.`
      },
      {
        role: 'user',
        content: `User Query: ${query}\n\nTool Results:\n${result}\n\nExtract and summarize the key information that answers this query:`
      }
    ]);

    let summary = extractedInfo.content.toString().trim();
    
    // Extract and log thinking if present (safe for all models)
    const { thinking, cleanedContent } = extractThinking(summary);
    
    // Log extraction thinking
    if (thinking && generationId && conversationId) {
      await redInstance.logger.logThought({
        content: thinking,
        source: 'toolPicker-extraction',
        generationId,
        conversationId,
      });
    }
    
    logThinking(thinking, 'ToolPicker');
    summary = cleanedContent;
    
    await redInstance.logger.log({
      level: 'success',
      category: 'tool',
      message: `<green>✓ Information extracted</green> <dim>(${summary.length} chars)</dim>`,
      generationId,
      conversationId,
      metadata: { summaryLength: summary.length },
    });
    
    // Add extracted/summarized info as a SystemMessage
    return {
      selectedTools: [toolUsed],
      messages: [
        new SystemMessage(`[INTERNAL CONTEXT - User cannot see this]\nRelevant information found:\n\n${summary}\n\nUse this information to answer the user's query directly and confidently. Do not say "according to search results" or reference external sources - answer as if you know this information.`)
      ]
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await redInstance.logger.log({
      level: 'error',
      category: 'tool',
      message: `<red>✗ Tool execution error:</red> ${errorMessage}`,
      generationId,
      conversationId,
      metadata: { error: errorMessage, tool: toolAction },
    });
    return { selectedTools: [], messages: [] };
  }
}
