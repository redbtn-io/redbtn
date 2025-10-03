import { InvokeOptions, Red } from '../../index';

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
 * @param state The current state of the graph.
 * @returns A partial state object with the response.
 */
export const chatNode = async (state: any): Promise<any> => {
  try {
    const redInstance: Red = state.redInstance;
    const query = state.query;
    const options: InvokeOptions = state.options || {};
    const conversationId = options.conversationId;

    // Build messages array with memory context if available
    let messages: any[] = [];
    
    if (conversationId) {
      // Get summary (if exists) and recent messages separately
      const summary = await redInstance.memory.getContextSummary(conversationId);
      const recentMessages = await redInstance.memory.getContextForConversation(conversationId);
      
      // Since Ollama doesn't combine system messages, we append summary
      // as a contextual user message instead (less intrusive than overriding system prompt)
      if (summary) {
        messages.push({
          role: 'user',
          content: `[Previous conversation context: ${summary}]`
        });
      }
      
      // Add recent conversation messages (user/assistant pairs)
      messages.push(...recentMessages.map(msg => ({
        role: msg.role,
        content: msg.content
      })));
    }

    // Add the current user query
    messages.push({
      role: 'user',
      content: query.message
    });

    // Invoke the local model with context
    // (streaming will be captured by streamEvents at the graph level)
    const aiMessage = await redInstance.localModel.invoke(messages);
    
    return { response: aiMessage };
    
  } catch (error) {
    console.error('[Chat Node] Error:', error);
    return { response: { content: 'Error processing request.' } };
  }
};
