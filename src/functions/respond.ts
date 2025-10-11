/**
 * Response generation and streaming utilities
 */

import type { Red } from '../index';
import type { InvokeOptions } from '../index';
import { redGraph } from '../lib/graphs/red';
import * as background from './background';

/**
 * Handles a direct, on-demand request from a user-facing application.
 * Automatically manages conversation history, memory, and summarization.
 * @param red The Red instance
 * @param query The user's input or request data (must have a 'message' property)
 * @param options Metadata about the source of the request and conversation settings
 * @returns For non-streaming: the full AIMessage object with content, tokens, metadata, and conversationId.
 *          For streaming: an async generator that yields metadata first (with conversationId), then string chunks, then finally the full AIMessage.
 */
export async function respond(
  red: Red,
  query: { message: string },
  options: InvokeOptions = {}
): Promise<any | AsyncGenerator<string | any, void, unknown>> {
  // Generate conversation ID if not provided
  const conversationId = options.conversationId || red.memory.generateConversationId(query.message);
  
  // Extract messageId for Redis pub/sub (if provided)
  const messageId = (options as any).messageId;
  console.log(`[Respond] Starting response with messageId: ${messageId || 'NONE'}, conversationId: ${conversationId}`);
  
  // Start a new generation (will fail if one is already in progress)
  const generationId = await red.logger.startGeneration(conversationId);
  if (!generationId) {
    throw new Error('A generation is already in progress for this conversation');
  }
  
  // Store user message in memory
  await red.memory.addMessage(conversationId, {
    role: 'user',
    content: query.message,
    timestamp: Date.now()
  });
  
  const initialState = {
    query,
    options: { ...options, conversationId, generationId }, // Add generationId to options
    redInstance: red, // Pass the entire instance into the graph
  };

  // Inject a system message into the graph state for every respond() call.
  // Use env override if available so this can be configured without code changes.
  const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `You are Red, an AI assistant developed by redbtn.io.
Current date: ${new Date().toLocaleDateString()}
Device: ${options.source?.device || 'unknown'}
Application: ${options.source?.application || 'unknown'}

CRITICAL RULES:
1. NEVER mention "knowledge cutoff", "training data", "as of my knowledge", or any limitations
2. NEVER introduce yourself unless this is the FIRST message in a new conversation or you're asked to do so
3. NEVER add disclaimers like "please note" or "for the most up-to-date information", and don't repeat the query to the user
4. If you have search results, use them directly and confidently
5. Be concise and helpful - answer the question directly without extra explanations`;
  // Attach as `systemMessage` so the chat node can include it while still loading
  // memory and the user query (we avoid pre-populating `messages` which would
  // prevent chatNode from inserting memory context).
  (initialState as any).systemMessage = SYSTEM_PROMPT;

  // Check if streaming is requested
  if (options.stream) {
    // Use LangGraph's streaming capabilities to stream through the graph
    return streamThroughGraphWithMemory(red, initialState, conversationId, generationId, messageId);
  } else {
    // Invoke the graph and return the full AIMessage
    const result = await redGraph.invoke(initialState);
    const response = result.response;
    
    // Store assistant response in memory
    await red.memory.addMessage(conversationId, {
      role: 'assistant',
      content: typeof response.content === 'string' ? response.content : JSON.stringify(response.content),
      timestamp: Date.now()
    });
    
    // Get message count for title generation
    const metadata = await red.memory.getMetadata(conversationId);
    const messageCount = metadata?.messageCount || 0;
    
    // Trigger background summarization (non-blocking)
    background.summarizeInBackground(conversationId, red.memory, red.localModel);
    
    // Trigger background title generation (non-blocking)
    background.generateTitleInBackground(conversationId, messageCount, red.memory, red.localModel);
    
    // Attach conversationId to response for server access
    return { ...response, conversationId };
  }
}

/**
 * Internal method to handle streaming responses through the graph with memory management.
 * Yields metadata first (with conversationId), then string chunks, then the final AIMessage object.
 * Extracts and logs thinking from models like DeepSeek-R1.
 * @private
 */
async function* streamThroughGraphWithMemory(
  red: Red,
  initialState: any,
  conversationId: string,
  generationId: string,
  messageId?: string
): AsyncGenerator<string | any, void, unknown> {
  try {
    // Import thinking utilities
    const { extractThinking, logThinking } = await import('../lib/utils/thinking');
    
    // Yield metadata first so server can capture conversationId and generationId immediately
    yield { _metadata: true, conversationId, generationId };
    
    // Note: Initial status is now published by the router node, not here
    // This prevents race conditions where "processing" overwrites "searching"
    
    // Use LangGraph's streamEvents to get token-level streaming
    const stream = redGraph.streamEvents(initialState, { version: "v1" });
    let finalMessage: any = null;
    let fullContent = '';
    let streamedTokens = false;
    let thinkingBuffer = '';
    let inThinkingTag = false;
    let eventCount = 0;
    let toolIndicatorSent = false;
    
    for await (const event of stream) {
      eventCount++;
      
      // Note: Tool status is now published by router node directly
      // No need to detect it here from stream events
      
      // Filter out LLM calls from router and toolPicker nodes (classification/tool selection)
      // Check multiple event properties to identify the source node
      const eventName = event.name || '';
      const eventTags = event.tags || [];
      const runName = event.metadata?.langgraph_node || '';
      
      // A node is router/toolPicker if any identifier contains those strings
      const isRouterOrToolPicker = 
        eventName.toLowerCase().includes('router') || 
        eventName.toLowerCase().includes('toolpicker') ||
        runName.toLowerCase().includes('router') ||
        runName.toLowerCase().includes('toolpicker') ||
        eventTags.some((tag: string) => tag.toLowerCase().includes('router') || tag.toLowerCase().includes('toolpicker'));
      
      // Yield streaming content chunks (for models that stream tokens)
      // But only from the chat node, not router/toolPicker
      if (event.event === "on_llm_stream" && event.data?.chunk?.content && !isRouterOrToolPicker) {
        let content = event.data.chunk.content;
        
        // Handle thinking tags in streamed content
        // We DON'T store thinking in fullContent - it will be stored separately
        // Only stream and store the cleaned content for conversation context
        for (let i = 0; i < content.length; i++) {
          const char = content[i];
          
          // Check for opening think tag
          if (!inThinkingTag && content.slice(i, i + 7) === '<think>') {
            inThinkingTag = true;
            i += 6; // Skip the tag
            // Emit status that thinking is starting
            if (messageId) {
              await red.messageQueue.publishStatus(messageId, { 
                action: 'thinking', 
                description: 'Reasoning through the problem' 
              });
              yield { _status: true, action: 'thinking', description: 'Reasoning through the problem' };
              process.stdout.write(`[Respond] Streaming thinking: 0 chars\r`);
            }
            continue;
          }
          
          // Check for closing think tag
          if (inThinkingTag && content.slice(i, i + 8) === '</think>') {
            if (messageId) {
              process.stdout.write(`\n[Respond] Thinking complete: ${thinkingBuffer.length} chars\n`);
            }
            inThinkingTag = false;
            i += 7; // Skip the tag
            // Log the accumulated thinking
            if (thinkingBuffer.trim()) {
              logThinking(thinkingBuffer.trim(), 'Chat (Streaming)');
              
              // Store thinking separately in database
              if (generationId && conversationId) {
                const thinkingContent = thinkingBuffer.trim();
                try {
                  const db = await import('../lib/memory/database').then(m => m.getDatabase());
                  const thoughtId = await db.storeThought({
                    thoughtId: `thought_${generationId}_${Date.now()}`,
                    conversationId,
                    generationId,
                    source: 'chat',
                    content: thinkingContent,
                    timestamp: new Date(),
                    metadata: {
                      streamChunk: true,
                    },
                  });
                } catch (err) {
                  console.error('[Respond] Failed to store streaming thinking:', err);
                }
              }
            }
            thinkingBuffer = '';
            continue;
          }
          
          // Accumulate thinking or stream regular content
          if (inThinkingTag) {
            thinkingBuffer += char;
            // Stream thinking character-by-character via special object
            if (messageId) {
              // Update progress indicator without logging each character
              if (thinkingBuffer.length % 100 === 0) {
                process.stdout.write(`[Respond] Streaming thinking: ${thinkingBuffer.length} chars\r`);
              }
              yield { _thinkingChunk: true, content: char };
            }
          } else {
            // Skip leading whitespace at the start of content
            if (!streamedTokens && (char === '\n' || char === '\r' || char === ' ')) {
              continue;
            }
            
            fullContent += char;
            streamedTokens = true;
            yield char; // Only stream non-thinking content
          }
        }
      }
      // Capture the final message when LLM completes - use on_llm_end
      // Only from chat node
      if (event.event === "on_llm_end" && !isRouterOrToolPicker) {
        // The AIMessage is nested in the generations array
        const generations = event.data?.output?.generations;
        if (generations && generations[0] && generations[0][0]?.message) {
          finalMessage = generations[0][0].message;
        }
      }
    }
    
    // If there's remaining thinking content at the end, log it
    if (thinkingBuffer.trim()) {
      logThinking(thinkingBuffer.trim(), 'Chat (Streaming)');
    }
    
    // If no tokens were streamed (e.g., when using tool calls like 'speak'),
    // get the final content and stream it character by character
    if (!streamedTokens && finalMessage && finalMessage.content) {
      // Extract thinking for logging (console)
      const { thinking, cleanedContent } = extractThinking(finalMessage.content);
      if (thinking) {
        logThinking(thinking, 'Chat (Non-streamed)');
        
        // Store thinking separately in database
        if (generationId && conversationId) {
          try {
            const db = await import('../lib/memory/database').then(m => m.getDatabase());
            const thoughtId = await db.storeThought({
              thoughtId: `thought_${generationId}`,
              conversationId,
              generationId,
              source: 'chat',
              content: thinking,
              timestamp: new Date(),
              metadata: {
                model: red.localModel.model,
              },
            });
            console.log(`[Respond] Stored thinking: ${thoughtId}`);
            
            // Publish to Redis for real-time updates
            if (messageId) {
              console.log(`[Respond] Publishing non-stream thinking to Redis for messageId: ${messageId}, length: ${thinking.length}`);
              await red.messageQueue.publishThinking(messageId, thinking);
              console.log(`[Respond] Published non-stream thinking successfully`);
            } else {
              console.warn(`[Respond] No messageId provided for non-stream thinking`);
            }
          } catch (err) {
            console.error('[Respond] Failed to store non-streamed thinking:', err);
          }
        }
      }
      // Use CLEANED content (thinking will be stored separately)
      fullContent = cleanedContent;
      
      // Stream the cleaned content for UX
      const words = cleanedContent.split(' ');
      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        yield i === 0 ? word : ' ' + word;
        // Small delay for smooth streaming effect (optional)
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    
    // Store assistant response in memory (after streaming completes)
    if (fullContent) {
      // Store content in memory for LLM context (already cleaned in streaming/non-streaming paths)
      await red.memory.addMessage(conversationId, {
        role: 'assistant',
        content: fullContent,
        timestamp: Date.now()
      });
      
      // Complete the generation
      await red.logger.completeGeneration(generationId, {
        response: fullContent,
        thinking: thinkingBuffer || undefined,
        route: (initialState as any).toolAction || 'chat',
        toolsUsed: (initialState as any).selectedTools,
        model: red.localModel.model,
        tokens: finalMessage?.usage_metadata,
      });
      
      // Get message count for title generation
      const metadata = await red.memory.getMetadata(conversationId);
      const messageCount = metadata?.messageCount || 0;
      
      // Trigger background summarization (non-blocking)
      background.summarizeInBackground(conversationId, red.memory, red.localModel);
      
      // Trigger background title generation (non-blocking)
      background.generateTitleInBackground(conversationId, messageCount, red.memory, red.localModel);
      
      // Trigger executive summary generation after 3rd+ message (non-blocking)
      if (messageCount >= 3) {
        background.generateExecutiveSummaryInBackground(conversationId, red.memory, red.localModel);
      }
    }
    
    // After all chunks are sent, yield the final AIMessage with complete token data
    if (finalMessage) {
      yield finalMessage;
    }
  } catch (error) {
    // Log the failure and mark generation as failed
    await red.logger.failGeneration(generationId, error instanceof Error ? error.message : String(error));
    throw error; // Re-throw to propagate the error
  }
}
