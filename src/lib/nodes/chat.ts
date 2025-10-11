import { InvokeOptions, Red } from '../../index';
import { allTools } from '../tools';
import { AIMessage } from '@langchain/core/messages';
import { extractThinking, logThinking } from '../utils/thinking';

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
    const generationId = options.generationId;

    // Log chat node start
    await redInstance.logger.log({
      level: 'info',
      category: 'chat',
      message: `<cyan>💬 Generating response...</cyan>`,
      generationId,
      conversationId,
    });

    // Never bind tools in chat node - tools are only executed by toolPicker
    // This prevents infinite loops where the LLM keeps calling tools
    const modelWithTools = redInstance.localModel;

    // Build messages array - start with existing messages from state
    let messages: any[] = [...(state.messages || [])];
    
    console.log('[Chat] Initial messages from state:', messages.length);
    
    // Check if the user query is already in messages
    const userQueryAlreadyAdded = messages.some(m => 
      (m.role === 'user' || m._getType?.() === 'human') && 
      m.content === query.message
    );
    
    console.log('[Chat] User query already in messages?', userQueryAlreadyAdded);
    
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
        
        console.log('[Chat] Loaded from memory - Summary:', !!summary, 'Recent messages:', recentMessages.length);
        console.log('[Chat] Recent messages:', recentMessages.map(m => ({ role: m.role, content: m.content?.substring(0, 30) })));
        
        // Since Ollama doesn't combine system messages, we append summary
        // as a contextual user message instead (less intrusive than overriding system prompt)
        if (summary) {
          initialMessages.push({
            role: 'user',
            content: `[Previous conversation context: ${summary}]`
          });
        }
        
        // Add recent conversation messages (user/assistant pairs)
        // Filter out the CURRENT user message (it will be added separately)
        const filteredMessages = recentMessages.filter(msg => 
          !(msg.role === 'user' && msg.content === query.message)
        );
        
        console.log('[Chat] Filtered out current message, remaining:', filteredMessages.length);
        
        initialMessages.push(...filteredMessages.map(msg => ({
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
    
    console.log('[Chat] Final message count before LLM:', messages.length);
    console.log('[Chat] Last 3 messages:', messages.slice(-3).map(m => ({ role: m.role, content: m.content?.substring(0, 50) })));

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
    
    // LOG THE FULL CONTENT TO PROVE THINKING IS THERE
    console.log('='.repeat(80));
    console.log('[Chat] FULL ACCUMULATED CONTENT FROM LLM:');
    console.log('='.repeat(80));
    console.log(fullContent);
    console.log('='.repeat(80));
    console.log(`[Chat] Total length: ${fullContent.length} chars`);
    console.log('='.repeat(80));
    
    // Construct AIMessage from accumulated content
    const aiMessage: AIMessage = new AIMessage({
      content: fullContent,
      usage_metadata,
      response_metadata,
    });
    
    // Log response metadata (including thinking tags if present)
    await redInstance.logger.log({
      level: 'success',
      category: 'chat',
      message: `<green>✓ Response generated</green> <dim>(${fullContent.length} chars, ${usage_metadata?.total_tokens || 0} tokens)</dim>`,
      generationId,
      conversationId,
      metadata: {
        contentLength: fullContent.length,
        tokens: usage_metadata,
        model: response_metadata?.model,
      },
    });
    
    return { 
      response: aiMessage,
      messages: [aiMessage] // Add AI message to state messages
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const generationId = (state.options as any)?.generationId;
    const conversationId = (state.options as any)?.conversationId;
    
    if (generationId && conversationId) {
      await state.redInstance.logger.log({
        level: 'error',
        category: 'chat',
        message: `<red>✗ Chat error:</red> ${errorMessage}`,
        generationId,
        conversationId,
        metadata: { error: errorMessage },
      });
    }
    
    return { 
      response: { content: 'Error processing request.' },
      messages: []
    };
  }
};
