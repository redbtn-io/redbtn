import { InvokeOptions, Red } from '../../index';
import { AIMessage } from '@langchain/core/messages';
import { extractThinking, logThinking } from '../utils/thinking';

/**
 * Responder Node - Final node that generates LLM responses
 * 
 * This node:
 * 1. Loads conversation context (if not provided in state)
 * 2. Uses system message from state or default
 * 3. Streams LLM response
 * 4. Handles thinking extraction
 * 
 * Always the final node in the graph after router and optional tool nodes
 */

interface ResponderState {
  query: { message: string };
  options: InvokeOptions;
  redInstance: Red;
  messageId?: string;
  messages?: any[]; // Messages array (may include context + tool results)
  systemMessage?: string; // Optional system message set by router/tool nodes
  contextMessages?: any[]; // Pre-loaded context messages
}

export const responderNode = async (state: ResponderState): Promise<any> => {
  try {
    const redInstance: Red = state.redInstance;
    const query = state.query;
    const options: InvokeOptions = state.options || {};
    const conversationId = options.conversationId;
    const generationId = options.generationId;
    const messageId = state.messageId;

    // Check if router passed through a direct response
    if ((state as any).directResponse) {
      const directText = (state as any).directResponse;
      
      await redInstance.logger.log({
        level: 'info',
        category: 'responder',
        message: `<cyan>💬 Streaming direct response from router (${directText.length} chars)</cyan>`,
        generationId,
        conversationId,
      });
      
      // Return as AIMessage for consistency
      return {
        response: new AIMessage({
          content: directText
        })
      };
    }

    // Publish status to frontend
    if (messageId) {
      await redInstance.messageQueue.publishStatus(messageId, {
        action: 'thinking',
        description: 'Generating response'
      });
    }

    // Log responder start
    await redInstance.logger.log({
      level: 'info',
      category: 'responder',
      message: `<cyan>💬 Generating response...</cyan>`,
      generationId,
      conversationId,
    });

    // Use the base chat model without tools
    const modelWithTools = redInstance.chatModel;

    // Build messages array
    let messages: any[] = [];
    
    // Check if messages were already built by a tool node
    if (state.messages && state.messages.length > 0) {
      console.log('[Responder] Using messages from state:', state.messages.length);
      messages = [...state.messages];
    } else {
      // Build messages from scratch
      const initialMessages: any[] = [];
      
      // Add system message (from state or default)
      const systemMessage = state.systemMessage || `You are Red, an AI assistant developed by redbtn.io.
Current date: ${new Date().toLocaleDateString()}

CRITICAL RULES:
1. NEVER mention "knowledge cutoff", "training data", "as of my knowledge", or any limitations
2. NEVER introduce yourself unless this is the FIRST message in a new conversation or you're asked to do so
3. NEVER add disclaimers like "please note" or "for the most up-to-date information"
4. Be direct, helpful, and conversational`;

      initialMessages.push({ role: 'system', content: systemMessage });
      
      // Load conversation context if we have a conversationId
      if (conversationId) {
        // Use Context MCP server to get formatted context history
        const contextResult = await redInstance.callMcpTool(
          'get_context_history',
          {
            conversationId,
            maxTokens: 30000,
            includeSummary: true,
            summaryType: 'trailing',
            format: 'llm'
          },
          {
            conversationId: conversationId,
            generationId: state.options?.generationId,
            messageId: state.messageId
          }
        );

        if (!contextResult.isError && contextResult.content?.[0]?.text) {
          const contextData = JSON.parse(contextResult.content[0].text);
          const contextMessages = contextData.messages || [];
          
          console.log('[Responder] Loaded from Context MCP - Messages:', contextMessages.length);
          
          // Filter out the CURRENT user message (it will be added separately)
          const filteredMessages = contextMessages.filter((msg: any) => 
            !(msg.role === 'user' && msg.content === query.message)
          );
          
          console.log('[Responder] Filtered out current message, remaining:', filteredMessages.length);
          
          initialMessages.push(...filteredMessages);
        } else {
          console.warn('[Responder] Failed to load context from MCP:', contextResult.isError ? 'error' : 'no content');
        }
      }

      messages = initialMessages;
      
      // Add the current user query
      if (query && query.message) {
        messages.push({
          role: 'user',
          content: query.message
        });
      }
    }
    
    console.log('[Responder] Final message count before LLM:', messages.length);
    console.log('[Responder] Last 3 messages:', messages.slice(-3).map(m => ({ role: m.role, content: m.content?.substring(0, 50) })));

    // Use streaming to get real-time chunks (including thinking tags)
    const stream = await modelWithTools.stream(messages);
    let fullContent = '';
    let usage_metadata: any = null;
    let response_metadata: any = null;
    
    // Accumulate chunks into full content
    for await (const chunk of stream) {
      if (chunk.content) {
        fullContent += chunk.content;
      }
      if (chunk.usage_metadata) {
        usage_metadata = chunk.usage_metadata;
      }
      if (chunk.response_metadata) {
        response_metadata = chunk.response_metadata;
      }
    }
    
    console.log('[Responder] Full content length:', fullContent.length);
    
    // Clean thinking tags from content before storing/returning
    const { thinking, cleanedContent } = extractThinking(fullContent);
    
    if (thinking) {
      console.log('[Responder] Extracted thinking length:', thinking.length);
    }
    console.log('[Responder] Cleaned content length:', cleanedContent.length);
    
    // Construct AIMessage from cleaned content (without thinking tags)
    const aiMessage: AIMessage = new AIMessage({
      content: cleanedContent,
      usage_metadata,
      response_metadata,
    });

    console.log('[Responder] Response generated, returning AIMessage');

    // Return the response wrapped in a partial state update
    return { response: aiMessage };

  } catch (error) {
    console.error('[Responder] Error in responder node:', error);
    throw error;
  }
};
