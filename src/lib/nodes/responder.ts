import { InvokeOptions, Red } from '../../index';
import { AIMessage } from '@langchain/core/messages';
import { extractThinking } from '../utils/thinking';
import { isNetworkError, wait } from '../utils/retry';
import { getNodeSystemPrefix } from '../utils/node-helpers';

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
  contextMessages?: any[]; // Pre-loaded from router
  systemMessage?: string; // Optional override
  messages?: any[]; // If already built by tool nodes
  messageId?: string;
  directResponse?: string; // For direct responses from router
  nodeNumber?: number; // Node position in graph (for system message)
  finalResponse?: string; // Pre-generated response from tool nodes
}

export const responderNode = async (state: ResponderState): Promise<any> => {
  try {
    const redInstance: Red = state.redInstance;
    const query = state.query;
    const options: InvokeOptions = state.options || {};
    const conversationId = options.conversationId;
    const generationId = options.generationId;
    const messageId = state.messageId;

    // Check if a node already generated the final response
    if (state.finalResponse) {
      await redInstance.logger.log({
        level: 'info',
        category: 'responder',
        message: `<cyan>💬 Using pre-generated response (${state.finalResponse.length} chars)</cyan>`,
        generationId,
        conversationId,
      });
      
      // Return as AIMessage for consistency
      return {
        response: new AIMessage({
          content: state.finalResponse
        })
      };
    }

    // Check if router passed through a direct response (legacy)
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
      messages = [...state.messages];
    } else {
      // Build messages from scratch using contextMessages from router
      const initialMessages: any[] = [];
      
      // Add system message (from state or default)
      // Note: Router is node 1, so responder is at least node 2 (or higher after tool nodes)
      const nodeNumber = state.nodeNumber || 2;
      const systemMessage = state.systemMessage || `${getNodeSystemPrefix(nodeNumber, 'Responder')}

You are Red, an AI assistant developed by redbtn.io.

CRITICAL RULES:
1. NEVER mention "knowledge cutoff", "training data", "as of my knowledge", or any limitations
2. NEVER introduce yourself unless this is the FIRST message in a new conversation or you're asked to do so
3. NEVER add disclaimers like "please note" or "for the most up-to-date information"
4. Be direct, helpful, and conversational`;

      initialMessages.push({ role: 'system', content: systemMessage });
      
      // Use pre-loaded context from router (already loaded once)
      if (state.contextMessages && state.contextMessages.length > 0) {
        console.log('[Responder] contextMessages received:', state.contextMessages.length);
        console.log('[Responder] contextMessages sample:', JSON.stringify(state.contextMessages.slice(0, 3).map(m => ({ role: m.role, contentLen: m.content?.length })), null, 2));
        
        // Filter out the CURRENT user message (it will be added separately)
        const filteredMessages = state.contextMessages.filter((msg: any) => 
          !(msg.role === 'user' && msg.content === query.message)
        );
        
        initialMessages.push(...filteredMessages);
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
    
    // DEBUG: Check for duplicate messages in the array
    console.log('[Responder] FULL MESSAGES ARRAY BEFORE LLM:');
    messages.forEach((msg, i) => {
      console.log(`  [${i}] role=${msg.role}, content=${msg.content?.substring(0, 80)}...`);
    });
    
    const messageCounts = new Map<string, number>();
    messages.forEach(msg => {
      const key = `${msg.role}:${msg.content?.substring(0, 100)}`;
      messageCounts.set(key, (messageCounts.get(key) || 0) + 1);
    });
    const duplicates = Array.from(messageCounts.entries()).filter(([_, count]) => count > 1);
    if (duplicates.length > 0) {
      console.error('[Responder] DUPLICATE MESSAGES DETECTED:', duplicates.map(([key, count]) => ({ key, count })));
    }

    const maxStreamAttempts = 3;
    for (let attempt = 1; attempt <= maxStreamAttempts; attempt++) {
      try {
        const stream = await modelWithTools.stream(messages);
        let fullContent = '';
        let usage_metadata: any = null;
        let response_metadata: any = null;

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

        const { thinking, cleanedContent } = extractThinking(fullContent);

        const aiMessage: AIMessage = new AIMessage({
          content: cleanedContent,
          usage_metadata,
          response_metadata,
        });

        // Check if using planner and if response is inadequate (trigger replan)
        const executionPlan = (state as any).executionPlan;
        const replannedCount = (state as any).replannedCount || 0;
        const MAX_REPLANS = 3;
        
        if (executionPlan && replannedCount < MAX_REPLANS) {
          // Detect if response is a non-answer (common patterns)
          const responseText = cleanedContent.toLowerCase();
          const nonAnswerPatterns = [
            "i don't have access to real-time",
            "i cannot access real-time",
            "i don't have access to current",
            "i cannot provide real-time",
            "i don't have the ability to",
            "i cannot browse",
            "my training data",
            "knowledge cutoff",
            "i'm not able to access",
            "i don't have information about",
            "i cannot check",
            "i'm unable to provide current"
          ];
          
          const isNonAnswer = nonAnswerPatterns.some(pattern => responseText.includes(pattern));
          
          // Also check if response is suspiciously short (< 50 chars) and doesn't answer the question
          const isTooShort = cleanedContent.length < 50;
          const userQuery = state.query?.message?.toLowerCase() || '';
          const isQuestion = userQuery.includes('?') || userQuery.includes('what') || 
                            userQuery.includes('how') || userQuery.includes('when') || 
                            userQuery.includes('where') || userQuery.includes('who');
          
          if ((isNonAnswer || (isTooShort && isQuestion)) && replannedCount < MAX_REPLANS) {
            await redInstance.logger.log({
              level: 'warn',
              category: 'responder',
              message: `<yellow>⚠ Inadequate response detected (${cleanedContent.length} chars), requesting replan</yellow>`,
              generationId,
              conversationId,
              metadata: {
                responseLength: cleanedContent.length,
                isNonAnswer,
                isTooShort,
                replannedCount
              }
            });
            
            // Trigger replanning
            return {
              response: aiMessage,  // Still return the response for context
              requestReplan: true,
              replanReason: isNonAnswer 
                ? 'Response indicated lack of real-time data or inability to answer'
                : 'Response too brief for the question asked',
              currentStepIndex: 0,  // Reset to start of new plan
              messages: [
                ...messages,
                { role: 'assistant', content: cleanedContent },
                { role: 'system', content: `Previous response was inadequate. The system will create a new plan to properly answer: "${state.query?.message}"` }
              ]
            };
          }
        }

        return { response: aiMessage };
      } catch (error) {
        if (!isNetworkError(error) || attempt === maxStreamAttempts) {
          throw error;
        }
        console.warn(`[Responder] Stream attempt ${attempt} failed due to network error, retrying...`, error);
        await wait(250 * attempt);
      }
    }

  } catch (error) {
    console.error('[Responder] Error in responder node:', error);
    throw error;
  }
};
