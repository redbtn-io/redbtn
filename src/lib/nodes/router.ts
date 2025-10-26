
import { InvokeOptions, Red } from '../..';
import { extractThinking, logThinking } from '../utils/thinking';

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
  const messageId = (state.options as any)?.messageId;
  
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
  
  // Get executive summary for context (if exists)
  let contextSummary = '';
  if (conversationId) {
    const summary = await redInstance.memory.getExecutiveSummary(conversationId);
    if (summary) {
      contextSummary = `\n\nConversation Context: ${summary}`;
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
    const modelWithJsonFormat = redInstance.chatModel.bind({ 
      format: "json" 
    });
    
    const response = await modelWithJsonFormat.invoke([
      {
        role: 'system',
        content: `You are a routing cognition node for an Artificial Intelligence named Red.

TODAY'S DATE: ${currentDate}

Your job is to analyze the user's message and determine which action to take.

YOU MUST RESPOND WITH ONLY VALID JSON. No other text before or after the JSON.

Required JSON format:
{
  "action": "WEB_SEARCH" | "SCRAPE_URL" | "SYSTEM_COMMAND" | "CHAT",
  "reasoning": "brief explanation",
  "searchQuery": "optional refined query for WEB_SEARCH",
  "url": "optional URL for SCRAPE_URL",
  "command": "optional command for SYSTEM_COMMAND"
}

Actions:
- WEB_SEARCH: Use when the query needs current/recent information from the internet (news, weather, sports scores, stock prices, current events, or when user explicitly asks to search the web)
- SCRAPE_URL: Use when the user provides a specific URL to read or analyze
- SYSTEM_COMMAND: Use when the user wants to execute a system command (list files, read files, run scripts, etc.)
- CHAT: Use for everything else (greetings, questions answerable with general knowledge, conversations, explanations)

Guidelines:
- If the query mentions a specific URL (http://, https://), choose SCRAPE_URL
- If the query is about recent events, breaking news, live data, choose WEB_SEARCH
- If the query asks to execute/run something on the system, choose SYSTEM_COMMAND
- When in doubt, choose CHAT

RESPOND WITH ONLY THE JSON OBJECT, NOTHING ELSE.`
      },
      {
        role: 'user',
        content: `${contextSummary ? `Conversation Context:\n${contextSummary}\n\n` : ''}User message: ${query}`
      }
    ]);
    
    // Parse the JSON response
    let routingDecision: RoutingDecision;
    try {
      routingDecision = JSON.parse(response.content as string);
      
      // Log successful parsing with full decision details
      await redInstance.logger.log({
        level: 'info',
        category: 'router',
        message: `<cyan>✓ Routing decision parsed successfully</cyan>`,
        generationId,
        conversationId,
        metadata: { 
          decision: routingDecision
        },
      });
      
    } catch (parseError) {
      // Log the full response if JSON parsing fails
      await redInstance.logger.log({
        level: 'error',
        category: 'router',
        message: `<red>✗ Failed to parse routing decision as JSON</red>`,
        generationId,
        conversationId,
        metadata: { 
          rawResponse: response.content,
          parseError: parseError instanceof Error ? parseError.message : String(parseError)
        },
      });
      
      throw new Error(`Failed to parse routing response: ${response.content}`);
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
            nextGraph: 'chat',
            reasoning: routingDecision.reasoning
          },
        });
        return { nextGraph: 'chat' };
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