
import { InvokeOptions, Red } from '../..';
import { extractThinking, logThinking } from '../utils/thinking';

/**
 * The first node in redGraph, acting as an intelligent router.
 * Analyzes the user query with conversation context to determine the next action:
 * - web_search: Query needs current information from the internet
 * - scrape_url: User provided a specific URL to scrape
 * - system_command: User wants to execute a system command
 * - chat: Query can be answered directly without external tools
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
    
    const routingDecision = await redInstance.localModel.invoke([
      {
        role: 'system',
        content: `You are a routing cognition node for an Artificial Intelligence named Red.

          TODAY'S DATE: ${currentDate}`
      },
      {
        role: 'user',
        content: `Analyze the user's message and classify it into ONE category.

Categories:
- WEB_SEARCH = needs current/recent information from the internet, anything current events related, sports cores, weather, news, stock prices, etc.
- SCRAPE_URL = user provided a specific URL to read
- SYSTEM_COMMAND = user wants to execute a system command (e.g. list files, read a file, run a script, etc.)
- CHAT = everything else (greetings, questions, general knowledge)

Your response MUST be EXACTLY one of these formats:
- WEB_SEARCH
- SCRAPE_URL: [url]
- SYSTEM_COMMAND: [command]
- CHAT

Use <think> tags for your reasoning, then give ONLY the category name outside the tags.

${contextSummary ? `Use the following context to help classify the message:
${contextSummary}` : ''}

User message: ${query}`
      }
    ]);
    
    let rawContent = routingDecision.content.toString().trim();
    
    // Extract thinking if present (safe for all models - returns original if no thinking)
    const { thinking, cleanedContent } = extractThinking(rawContent);
    
    // Log thinking to console (for development)
    logThinking(thinking, 'Router');
    
    // Log thinking to logging system (separate from response)
    if (thinking && generationId && conversationId) {
      await redInstance.logger.logThought({
        content: thinking,
        source: 'router',
        generationId,
        conversationId,
      });
    }
    
    // Extract just the routing action from the response
    // Look for WEB_SEARCH, CHAT, SCRAPE_URL, or SYSTEM_COMMAND
    // Prioritize patterns with URL/command, then standalone keywords
    // Also handle variations like "Web Search:" or "web_search"
    const routingPatterns = [
      { pattern: /\b(SCRAPE_URL:\s*https?:\/\/[^\s<]+)/i, name: 'SCRAPE_URL_WITH_URL' },
      { pattern: /\b(SYSTEM_COMMAND:\s*[^\n<]+)/i, name: 'SYSTEM_COMMAND_WITH_CMD' },
      { pattern: /^(WEB[_\s-]?SEARCH)\b/im, name: 'WEB_SEARCH_LINE_START' },  // Matches WEB_SEARCH, WEB SEARCH, etc.
      { pattern: /\b(WEB[_\s-]?SEARCH)\b/i, name: 'WEB_SEARCH' },
      { pattern: /^(SCRAPE[_\s-]?URL)\b/im, name: 'SCRAPE_URL_LINE_START' },
      { pattern: /\b(SCRAPE[_\s-]?URL)\b/i, name: 'SCRAPE_URL' },
      { pattern: /^(SYSTEM[_\s-]?COMMAND)\b/im, name: 'SYSTEM_COMMAND_LINE_START' },
      { pattern: /\b(SYSTEM[_\s-]?COMMAND)\b/i, name: 'SYSTEM_COMMAND' },
      { pattern: /^(CHAT)\b/im, name: 'CHAT_LINE_START' },
      { pattern: /\b(CHAT)\b/i, name: 'CHAT' }
    ];
    
    let decision = '';
    
    // First try to find pattern in cleaned content (outside thinking tags)
    for (const { pattern, name } of routingPatterns) {
      const match = cleanedContent.match(pattern);
      if (match) {
        // Normalize to standard format (WEB_SEARCH, not WEB SEARCH)
        decision = match[1].toUpperCase().replace(/[\s-]/g, '_').trim();
        break;
      }
    }
    
    // If not found in cleaned content, look in thinking
    if (!decision && thinking) {
      for (const { pattern, name } of routingPatterns) {
        const match = thinking.match(pattern);
        if (match) {
          // Normalize to standard format (WEB_SEARCH, not WEB SEARCH)
          decision = match[1].toUpperCase().replace(/[\s-]/g, '_').trim();
          break;
        }
      }
    }
    
    // Single log showing final routing decision with cleaned answer
    console.log(`[Router] Decision: ${decision || 'CHAT'} (from ${cleanedContent.substring(0, 50)}${cleanedContent.length > 50 ? '...' : ''})`);
    
    if (decision.startsWith('WEB_SEARCH')) {
      // Publish tool status to frontend
      if (messageId) {
        console.log(`[Router] Publishing tool_status to Redis for ${messageId}: web_search`);
        await redInstance.messageQueue.publishToolStatus(messageId, {
          status: '🔍 Searching the web...',
          action: 'web_search'
        });
        console.log(`[Router] tool_status published successfully`);
      }
      
      await redInstance.logger.log({
        level: 'success',
        category: 'router',
        message: `<green>→ Route:</green> <bold>WEB_SEARCH</bold>`,
        generationId,
        conversationId,
        metadata: { decision: 'WEB_SEARCH', nextGraph: 'toolPicker', toolAction: 'web_search' },
      });
      return { nextGraph: 'toolPicker', toolAction: 'web_search' };
    }
    
    if (decision.startsWith('SCRAPE_URL')) {
      const urlMatch = decision.match(/SCRAPE_URL:\s*(.+)$/i);
      const url = urlMatch ? urlMatch[1].trim() : '';
      
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
        metadata: { decision: 'SCRAPE_URL', url, nextGraph: 'toolPicker', toolAction: 'scrape_url' },
      });
      return { nextGraph: 'toolPicker', toolAction: 'scrape_url', toolParam: url };
    }
    
    if (decision.startsWith('SYSTEM_COMMAND')) {
      const cmdMatch = decision.match(/SYSTEM_COMMAND:\s*(.+)$/i);
      const command = cmdMatch ? cmdMatch[1].trim() : '';
      
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
        metadata: { decision: 'SYSTEM_COMMAND', command, nextGraph: 'toolPicker', toolAction: 'system_command' },
      });
      return { nextGraph: 'toolPicker', toolAction: 'system_command', toolParam: command };
    }
    
    // Default to CHAT
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
      metadata: { decision: 'CHAT', nextGraph: 'chat' },
    });
    return { nextGraph: 'chat' };
    
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