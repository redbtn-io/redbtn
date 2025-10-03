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
export async function chatNode(state: RedGraphState): Promise<Partial<RedGraphState>> {
  try {
    const redInstance = state.redInstance;
    const userText = (state.query && (state.query as any).message) ? (state.query as any).message : JSON.stringify(state.query || {});
    const conversationId = (state.options as any)?.conversationId;

    if (!redInstance) {
      return { response: { content: 'This is a placeholder response from the chat node.' } };
    }

    try {
      let messages: any[] = [];
      
      // If we have a conversation ID, get the context with history/summary
      if (conversationId) {
        const contextMessages = await redInstance.memory.getContextForConversation(conversationId);
        messages = contextMessages.map(m => ({ role: m.role, content: m.content }));
      }
      
      // Add current user message
      messages.push({ role: 'user', content: userText });
      
      // Invoke the model with full context (streaming will be captured by streamEvents at the graph level)
      const aiMessage = await redInstance.localModel.invoke(messages);
      return { response: aiMessage };
    } catch (err) {
      console.error('[Chat Node] Error invoking model:', err);
      return { response: { content: 'Error processing request.' } };
    }
  } catch (err) {
    console.error('[Chat Node] Unexpected error:', err);
    return { response: { content: 'This is a placeholder response from the chat node.' } };
  }
}
