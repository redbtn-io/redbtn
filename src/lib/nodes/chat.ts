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
  console.log(`[Chat Node] Processing query:`, state.query);
  // Try to use the Red instance's local model (ChatOllama) if available
  try {
    const redInstance = state.redInstance;
    const userText = (state.query && (state.query as any).message) ? (state.query as any).message : JSON.stringify(state.query || {});

    if (!redInstance) {
      console.warn('[Chat Node] No Red instance present in state; skipping model invocation and using placeholder.');
    } else {
      try {
        // Check if streaming is requested (we'll add this to options later)
        const shouldStream = (state.options as any)?.stream;
        
        if (shouldStream) {
          // For streaming, use the model's stream method 
          // LangGraph's streamEvents will capture the streaming tokens automatically
          let fullResponse = '';
          const stream = await redInstance.localModel.stream([
            { role: "user", content: userText }
          ]);
          
          for await (const chunk of stream) {
            fullResponse += chunk.content;
          }
          
          console.log('[Chat Node] Streaming complete');
          // For streaming, we still return the response for state tracking
          // The actual streaming and final metadata happens at the graph level
          return { response: { content: fullResponse } };
        } else {
          // Non-streaming mode - return the full AIMessage
          const aiMessage = await redInstance.localModel.invoke([
            { role: "user", content: userText }
          ]);
          console.log('[Chat Node] Model response received:', aiMessage);
          return { response: aiMessage };
        }
      } catch (err) {
        console.error('[Chat Node] Error invoking local model:', err);
      }
    }
  } catch (err) {
    console.error('[Chat Node] Unexpected error in chat node:', err);
  }

  // Final fallback placeholder
  return { response: { content: 'This is a placeholder response from the chat node.' } };
}
