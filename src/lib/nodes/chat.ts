import { InvokeOptions, Red } from '../../index';
import { allTools } from '../tools';
import { AIMessage } from '@langchain/core/messages';

/**
 * Defines the state that flows through the redGraph.
 * It includes the original query and the invocation options.
 */
interface RedGraphState {
  query: object;
  options: InvokeOptions;
  response?: any; // The full AIMessage object from the LLM
  nextGraph?: 'homeGraph' | 'assistantGraph' | 'chat';
  // optional reference to the Red instance provided by the caller
  redInstance?: Red;
}

/**
 * The chat node that processes queries and generates responses.
 * Tools are bound to the model, and tool execution is handled by the toolNode.
 * @param state The current state of the graph.
 * @returns A partial state object with the response and updated messages.
 */
export const chatNode = async (state: any): Promise<any> => {
  try {
    const redInstance: Red = state.redInstance;
    const query = state.query;
    const options: InvokeOptions = state.options || {};
    const conversationId = options.conversationId;

    // Never bind tools in chat node - tools are only executed by toolPicker
    // This prevents infinite loops where the LLM keeps calling tools
    const modelWithTools = redInstance.localModel;

    // Build messages array - start with existing messages from state
    let messages: any[] = [...(state.messages || [])];
    
    // Check if the user query is already in messages
    const userQueryAlreadyAdded = messages.some(m => 
      (m.role === 'user' || m._getType?.() === 'human') && 
      m.content === query.message
    );
    
    if (!userQueryAlreadyAdded) {
      const initialMessages: any[] = [];
      
      // Inject system message if provided by the caller (respond())
      if (state.systemMessage) {
        initialMessages.push({ role: 'system', content: state.systemMessage });
      }
      
      if (conversationId) {
        // Get summary (if exists) and recent messages separately
        const summary = await redInstance.memory.getContextSummary(conversationId);
        const recentMessages = await redInstance.memory.getContextForConversation(conversationId);
        
        // Since Ollama doesn't combine system messages, we append summary
        // as a contextual user message instead (less intrusive than overriding system prompt)
        if (summary) {
          initialMessages.push({
            role: 'user',
            content: `[Previous conversation context: ${summary}]`
          });
        }
        
        // Add recent conversation messages (user/assistant pairs)
        initialMessages.push(...recentMessages.map(msg => ({
          role: msg.role,
          content: msg.content
        })));
      }

      // Prepend initial context, then add existing messages (e.g., tool results), then user query
      messages = [...initialMessages, ...messages];
      
      // Add the current user query
      if (query && query.message) {
        messages.push({
          role: 'user',
          content: query.message
        });
      }
    }

    // Invoke the model with tools bound
    const aiMessage: AIMessage = await modelWithTools.invoke(messages);
    
    return { 
      response: aiMessage,
      messages: [aiMessage] // Add AI message to state messages
    };
    
  } catch (error) {
    console.error('[Chat Node] Error:', error);
    return { 
      response: { content: 'Error processing request.' },
      messages: []
    };
  }
};
