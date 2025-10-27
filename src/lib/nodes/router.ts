
import { InvokeOptions, Red } from '../..';
import { extractThinking, logThinking } from '../utils/thinking';
import { extractJSONWithDetails } from '../utils/json-extractor';

/**
 * JSON schema for routing decisions (structured output)
 */
const routingDecisionSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['WEB_SEARCH', 'SCRAPE_URL', 'SYSTEM_COMMAND', 'CHAT'],
      description: 'The routing action to take based on the user query'
    },
    reasoning: {
      type: 'string',
      description: 'Brief explanation of why this action was chosen'
    },
    url: {
      type: 'string',
      description: 'The URL to scrape (only for SCRAPE_URL action)'
    },
    command: {
      type: 'string',
      description: 'The system command to execute (only for SYSTEM_COMMAND action)'
    },
    searchQuery: {
      type: 'string',
      description: 'Refined search query (only for WEB_SEARCH action)'
    }
  },
  required: ['action', 'reasoning'],
  additionalProperties: false
} as const;

interface RoutingDecision {
  action: 'WEB_SEARCH' | 'SCRAPE_URL' | 'SYSTEM_COMMAND' | 'CHAT';
  reasoning: string;
  url?: string;
  command?: string;
  searchQuery?: string;
}

/**
 * The first node in redGraph, acting as an intelligent router.
 * Analyzes the user query with conversation context to determine the next action:
 * - web_search: Query needs current information from the internet
 * - scrape_url: User provided a specific URL to scrape
 * - system_command: User wants to execute a system command
 * - chat: Query can be answered directly without external tools
 * 
 * Uses structured outputs with Zod schema for reliable routing decisions.
 * 
 * @param state The current state of the graph.
 * @returns A partial state object indicating the next step.
 */
export const routerNode = async (state: any) => {
  const query = state.messages[state.messages.length - 1]?.content || state.query?.message || '';
  const redInstance: Red = state.redInstance;
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  const messageId = state.messageId; // Get from top-level state, not options
  
  // Publish routing status to frontend
  if (messageId) {
    await redInstance.messageQueue.publishStatus(messageId, {
      action: 'routing',
      description: 'Analyzing query'
    });
  }
  
  // Log router start
  await redInstance.logger.log({
    level: 'info',
    category: 'router',
    message: `<cyan>🧭 Analyzing query:</cyan> <dim>${query.substring(0, 80)}${query.length > 80 ? '...' : ''}</dim>`,
    generationId,
    conversationId,
  });
  
  // Get executive summary for context (if exists) via Context MCP
  let contextSummary = '';
  if (conversationId) {
    try {
      const summaryResult = await redInstance.callMcpTool(
        'get_summary',
        {
          conversationId,
          summaryType: 'executive'
        },
        {
          conversationId,
          generationId,
          messageId
        }
      );

      if (!summaryResult.isError && summaryResult.content?.[0]?.text) {
        const summaryData = JSON.parse(summaryResult.content[0].text);
        const summary = summaryData.summary;
        if (summary) {
          contextSummary = `\n\nConversation Context: ${summary}`;
        }
      }
    } catch (error) {
      console.warn('[Router] Failed to get executive summary from Context MCP:', error);
    }
  }
  
  try {
    const currentDate = new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    
    // Force JSON output from Ollama models
    const modelWithJsonFormat = redInstance.workerModel.withStructuredOutput({
      schema: routingDecisionSchema
    });
    
    const response = await modelWithJsonFormat.invoke([
      {
        role: 'system',
        content: `You are a routing cognition node for an Artificial Intelligence named Red.

TODAY'S DATE: ${currentDate}

Your job is to analyze the user's message and determine which action to take.

Actions:
- WEB_SEARCH: Use when the query needs current/recent information from the internet (news, weather, sports scores, stock prices, current events, or when user explicitly asks to search the web)
- SCRAPE_URL: Use when the user provides a specific URL to read or analyze
- SYSTEM_COMMAND: Use when the user wants to execute a system command (list files, read files, run scripts, etc.)
- CHAT: Use for everything else (greetings, questions answerable with general knowledge, conversations, explanations)

Guidelines:
- If the query mentions a specific URL (http://, https://), choose SCRAPE_URL
- If the query is about recent events, breaking news, live data, choose WEB_SEARCH
- If the query asks to execute/run something on the system, choose SYSTEM_COMMAND
- When in doubt, choose CHAT`
      },
      {
        role: 'user',
        content: `${contextSummary ? `Conversation Context:\n${contextSummary}\n\n` : ''}User message: ${query}`
      }
    ]);
    
    // With structured output, response is already parsed
    let routingDecision: RoutingDecision;
    
    // Check if response is already an object (structured output) or needs parsing
    if (typeof response === 'object' && response !== null) {
      // Check if it's in tool call format: {name, arguments}
      if ('name' in response && 'arguments' in response) {
        const toolCall = response as { name: string; arguments: any };
        
        // Extract the actual data from arguments
        routingDecision = {
          action: toolCall.name as RoutingDecision['action'],
          reasoning: toolCall.arguments.reasoning || '',
          searchQuery: toolCall.arguments.searchQuery || toolCall.arguments.query,
          url: toolCall.arguments.url,
          command: toolCall.arguments.command
        };
        
        await redInstance.logger.log({
          level: 'success',
          category: 'router',
          message: `<green>✓ Routing decision received (tool call format)</green>`,
          generationId,
          conversationId,
          metadata: { 
            decision: routingDecision,
            method: 'tool_call_format',
            rawToolCall: toolCall
          },
        });
        
      } else if ('action' in response) {
        // Already structured - direct from withStructuredOutput
        routingDecision = response as RoutingDecision;
        
        await redInstance.logger.log({
          level: 'success',
          category: 'router',
          message: `<green>✓ Routing decision received (structured output)</green>`,
          generationId,
          conversationId,
          metadata: { 
            decision: routingDecision,
            method: 'structured_output'
          },
        });
        
      } else {
        // Unknown object format, try to extract
        throw new Error(`Unknown response format: ${JSON.stringify(response)}`);
      }
      
    } else {
      // Check if response has direct text content
      // Check top-level: response/text/content/message
      let directText = (response as any)?.response || 
                       (response as any)?.text || 
                       (response as any)?.content ||
                       (response as any)?.message;
      
      // Check nested in 'response' property
      if (!directText && (response as any)?.response && typeof (response as any).response === 'object') {
        const resp = (response as any).response;
        directText = resp.response || resp.text || resp.content || resp.message;
      }
      
      // Check nested in 'arguments' property
      if (!directText && (response as any)?.arguments) {
        const args = (response as any).arguments;
        directText = args.response || args.text || args.content || args.message;
      }
      
      // Check nested in 'data' property
      if (!directText && (response as any)?.data) {
        const data = (response as any).data;
        directText = data.response || data.text || data.content || data.message;
      }
      
      if (typeof directText === 'string' && directText.trim().length > 0) {
        // Response contains direct text - stream it and skip to responder
        await redInstance.logger.log({
          level: 'info',
          category: 'router',
          message: `<cyan>📋 Router received text response, passing through</cyan>`,
          generationId,
          conversationId,
          metadata: { 
            hasDirectText: true,
            textLength: directText.length
          },
        });
        
        // Store the direct response in state so responder can stream it
        return { 
          nextGraph: 'responder',
          directResponse: directText
        };
      }
      
      // Fallback: response has content property that needs extraction
      const rawResponse = typeof response === 'string' ? response : (response as any)?.content || JSON.stringify(response);
      
      // Log the full raw response for debugging
      await redInstance.logger.log({
        level: 'info',
        category: 'router',
        message: `<cyan>📋 Raw LLM response received</cyan>`,
        generationId,
        conversationId,
        metadata: { 
          rawResponse,
          responseLength: rawResponse.length,
          responseType: typeof response
        },
      });
      
      // Try to extract JSON from the response
      const extractionResult = extractJSONWithDetails<RoutingDecision>(
        rawResponse,
        { action: undefined, reasoning: undefined } // Expected shape
      );
      
      if (extractionResult.success && extractionResult.data) {
        routingDecision = extractionResult.data;
        
        // Log successful extraction with details
        await redInstance.logger.log({
          level: 'success',
          category: 'router',
          message: `<green>✓ Routing decision extracted successfully</green> <dim>(strategy: ${extractionResult.strategy})</dim>`,
          generationId,
          conversationId,
          metadata: { 
            decision: routingDecision,
            extractionStrategy: extractionResult.strategy,
            extractedText: extractionResult.extractedText,
            hadExtraText: extractionResult.extractedText !== rawResponse.trim()
          },
        });
        
      } else {
        // Log failure with full details
        await redInstance.logger.log({
          level: 'error',
          category: 'router',
          message: `<red>✗ Failed to extract routing decision from response</red>`,
          generationId,
          conversationId,
          metadata: { 
            rawResponse,
            extractionError: extractionResult.error,
            attemptedStrategies: ['direct', 'braces', 'codeblock']
          },
        });
        
        throw new Error(`Failed to parse routing response: ${extractionResult.error}`);
      }
    }
    
    // Log the reasoning and action details
    const optionalFields: string[] = [];
    if (routingDecision.searchQuery) optionalFields.push(`searchQuery: ${routingDecision.searchQuery}`);
    if (routingDecision.url) optionalFields.push(`url: ${routingDecision.url}`);
    if (routingDecision.command) optionalFields.push(`command: ${routingDecision.command}`);
    
    await redInstance.logger.log({
      level: 'info',
      category: 'router',
      message: `<cyan>Decision:</cyan> <bold>${routingDecision.action}</bold> <dim>${optionalFields.length > 0 ? `(${optionalFields.join(', ')})` : ''}</dim>`,
      generationId,
      conversationId,
      metadata: {
        action: routingDecision.action,
        reasoning: routingDecision.reasoning,
        ...(routingDecision.searchQuery && { searchQuery: routingDecision.searchQuery }),
        ...(routingDecision.url && { url: routingDecision.url }),
        ...(routingDecision.command && { command: routingDecision.command })
      }
    });
    
    // Log reasoning as "thinking" in the logging system
    if (routingDecision.reasoning && generationId && conversationId) {
      await redInstance.logger.logThought({
        content: routingDecision.reasoning,
        source: 'router',
        generationId,
        conversationId,
      });
    }
    
    // Route based on action
    switch (routingDecision.action) {
      case 'WEB_SEARCH': {
        // Publish tool_status so frontend knows we're searching
        if (messageId) {
          await redInstance.messageQueue.publishToolStatus(messageId, {
            status: '🔍 Searching the web...',
            action: 'web_search'
          });
        }

        await redInstance.logger.log({
          level: 'success',
          category: 'router',
          message: `<green>→ Route:</green> <bold>WEB_SEARCH</bold> <dim>${routingDecision.searchQuery || ''}</dim>`,
          generationId,
          conversationId,
          metadata: { 
            decision: 'WEB_SEARCH', 
            nextGraph: 'search',
            searchQuery: routingDecision.searchQuery,
            reasoning: routingDecision.reasoning
          },
        });
        return { 
          nextGraph: 'search',
          toolParam: routingDecision.searchQuery || query
        };
      }
      
      case 'SCRAPE_URL': {
        const url = routingDecision.url || '';
        
        // Publish tool status to frontend
        if (messageId) {
          await redInstance.messageQueue.publishToolStatus(messageId, {
            status: '📄 Reading webpage...',
            action: 'scrape_url'
          });
        }
        
        await redInstance.logger.log({
          level: 'success',
          category: 'router',
          message: `<green>→ Route:</green> <bold>SCRAPE_URL</bold> <dim>${url}</dim>`,
          generationId,
          conversationId,
          metadata: { 
            decision: 'SCRAPE_URL', 
            url, 
            nextGraph: 'scrape',
            reasoning: routingDecision.reasoning
          },
        });
        return { nextGraph: 'scrape', toolParam: url };
      }
      
      case 'SYSTEM_COMMAND': {
        const command = routingDecision.command || '';
        
        // Publish tool status to frontend
        if (messageId) {
          await redInstance.messageQueue.publishToolStatus(messageId, {
            status: '⚙️ Executing command...',
            action: 'system_command'
          });
        }
        
        await redInstance.logger.log({
          level: 'success',
          category: 'router',
          message: `<green>→ Route:</green> <bold>SYSTEM_COMMAND</bold> <dim>${command}</dim>`,
          generationId,
          conversationId,
          metadata: { 
            decision: 'SYSTEM_COMMAND', 
            command, 
            nextGraph: 'command',
            reasoning: routingDecision.reasoning
          },
        });
        return { nextGraph: 'command', toolParam: command };
      }
      
      case 'CHAT':
      default: {
        // Publish chat status to frontend
        if (messageId) {
          await redInstance.messageQueue.publishStatus(messageId, {
            action: 'processing',
            description: 'Generating response'
          });
        }
        
        await redInstance.logger.log({
          level: 'success',
          category: 'router',
          message: `<green>→ Route:</green> <bold>CHAT</bold>`,
          generationId,
          conversationId,
          metadata: { 
            decision: 'CHAT', 
            nextGraph: 'responder',
            reasoning: routingDecision.reasoning
          },
        });
        return { nextGraph: 'responder' };
      }
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await redInstance.logger.log({
      level: 'error',
      category: 'router',
      message: `<red>✗ Router error:</red> ${errorMessage} <dim>(defaulting to CHAT)</dim>`,
      generationId,
      conversationId,
      metadata: { error: errorMessage },
    });
    return { nextGraph: 'chat' };
  }
};