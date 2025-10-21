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
  
  // Start a new generation (will fail if one is already in progress)
  const generationId = await red.logger.startGeneration(conversationId);
  if (!generationId) {
    await red.logger.log({
      level: 'warn',
      category: 'system',
      message: 'Generation already in progress for conversation',
      conversationId,
      metadata: { query: query.message.substring(0, 100) }
    });
    throw new Error('A generation is already in progress for this conversation');
  }
  
  // Log generation start
  await red.logger.log({
    level: 'info',
    category: 'system',
    message: `<cyan>Starting generation</cyan> <dim>${generationId}</dim>`,
    generationId,
    conversationId,
    metadata: {
      messageId,
      queryLength: query.message.length,
      source: options.source
    }
  });
  
  // Store user message in memory
  await red.memory.addMessage(conversationId, {
    role: 'user',
    content: query.message,
    timestamp: Date.now(),
    toolExecutions: [] // User messages don't have tool executions
  });
  
  const initialState = {
    query,
    options: { ...options, conversationId, generationId }, // Add generationId to options
    redInstance: red, // Pass the entire instance into the graph
    messageId, // Add messageId to state for tool event publishing
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
3. NEVER add disclaimers like "please note" or "for the most up-to-date information"
4. NEVER repeat or rephrase the user's question in your response - just answer it directly
5. NEVER say things like "searching for...", "looking up...", or mention what search query was used
6. If you have search results, use them directly and confidently
7. Be concise and helpful - answer the question directly without extra explanations`;
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
      id: messageId, // Include the message ID for consistent linking
      role: 'assistant',
      content: typeof response.content === 'string' ? response.content : JSON.stringify(response.content),
      timestamp: Date.now(),
      toolExecutions: [] // TODO: Implement tool execution data collection
    });
    
    // Get message count for title generation
    const metadata = await red.memory.getMetadata(conversationId);
    const messageCount = metadata?.messageCount || 0;
    
    // Trigger background summarization (non-blocking)
    background.summarizeInBackground(conversationId, red.memory, red.chatModel);
    
    // Trigger background title generation (non-blocking)
    background.generateTitleInBackground(conversationId, messageCount, red.memory, red.chatModel);
    
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
    
    // Import tool event system (disabled - not implemented yet)
    // const { createIntegratedPublisher } = await import('../lib/events/integrated-publisher');
    
    // Create tool event publisher for thinking (if we have a messageId)
    let thinkingPublisher: any = null;
    // if (messageId) {
    //   thinkingPublisher = createIntegratedPublisher(
    //     red.messageQueue,
    //     'thinking',
    //     'AI Reasoning',
    //     messageId,
    //     conversationId
    //   );
    // }
    
    // Yield metadata first so server can capture conversationId and generationId immediately
    yield { _metadata: true, conversationId, generationId };
    
    // Note: Initial status is now published by the router node, not here
    // This prevents race conditions where "processing" overwrites "searching"
    
    // Use LangGraph's streamEvents to get token-level streaming
    const stream = redGraph.streamEvents(initialState, { version: "v1" });
    let finalMessage: any = null;
    let fullContent = '';
    let streamedTokens = false;
    let streamedThinking = false; // Track if we streamed any thinking
    let thinkingBuffer = '';
    let inThinkingTag = false;
    let eventCount = 0;
    let toolIndicatorSent = false;
    let pendingBuffer = ''; // Buffer for partial tag detection across chunks
    
    for await (const event of stream) {
      eventCount++;
      
      // Note: Tool status is now published by router node directly
      // No need to detect it here from stream events
      
      // Filter out LLM calls from router and toolPicker nodes (classification/tool selection)
      // Check multiple event properties to identify the source node
      const eventName = event.name || '';
      const eventTags = event.tags || [];
      const runName = event.metadata?.langgraph_node || '';
      
      // DEBUG: Log ALL LLM stream events to see what nodes are streaming
      if (event.event === "on_llm_stream" && event.data?.chunk?.content) {
        console.log(`[Respond] 🔍 LLM STREAM EVENT - runName:"${runName}", eventName:"${eventName}", contentLength:${event.data.chunk.content.length}`);
      }
      
      // CRITICAL: Only stream content from the chat node
      // All other LLM calls (router, optimizer, search extractors, etc.) are internal
      // The langgraph_node metadata should be exactly "chat" for the chat node
      const isChatNode = runName === 'chat';
      
      // Yield streaming content chunks (for models that stream tokens)
      // But ONLY from the chat node - all other LLM calls are internal
      if (event.event === "on_llm_stream" && event.data?.chunk?.content && isChatNode) {
        let content = event.data.chunk.content;
        
        console.log(`[Respond] ⚡ STREAMING CHUNK RECEIVED - isChatNode:${isChatNode}, length:${content.length}`);
        
        // 🔍 DEBUG: Log first 100 chars of EVERY chunk to see what Phi-4 outputs
        if (content.length > 0) {
          const preview = content.substring(0, 100).replace(/\n/g, '\\n');
          console.log(`[Respond] 📦 RAW CHUNK (${content.length} chars): "${preview}"`);
        }
        
        // Add content to pending buffer for tag detection
        pendingBuffer += content;
        
        // Process pending buffer character by character
        // Keep last 8 chars in buffer in case we get partial tag at chunk boundary
        while (pendingBuffer.length > 8) {
          // Check for opening think tag in pending buffer
          if (!inThinkingTag && pendingBuffer.startsWith('<think>')) {
            inThinkingTag = true;
            pendingBuffer = pendingBuffer.slice(7); // Remove '<think>'
            console.log('[Respond] 🧠 THINKING TAG OPENED | Next chars:', pendingBuffer.substring(0, 50));
            
            // Publish tool start event
            if (thinkingPublisher) {
              await thinkingPublisher.publishStart({
                model: red.chatModel.model,
              });
            }
            
            // Emit status that thinking is starting (legacy)
            if (messageId) {
              await red.messageQueue.publishStatus(messageId, { 
                action: 'thinking', 
                description: 'Reasoning through the problem' 
              });
              yield { _status: true, action: 'thinking', description: 'Reasoning through the problem' };
              process.stdout.write(`[Respond] Streaming thinking: 0 chars\r`);
            }
            continue; // Recheck buffer after removing tag
          }
          
          // Check for closing think tag
          if (inThinkingTag && pendingBuffer.startsWith('</think>')) {
            console.log('[Respond] 🧠 THINKING TAG CLOSED - accumulated', thinkingBuffer.length, 'chars');
            if (messageId) {
              process.stdout.write(`\n[Respond] Thinking complete: ${thinkingBuffer.length} chars\n`);
            }
            inThinkingTag = false;
            pendingBuffer = pendingBuffer.slice(8); // Remove '</think>'
            
            // ✨ IMPORTANT: Send a space character immediately to trigger thinking shrink
            // This ensures frontend gets a content chunk even if whitespace follows
            console.log('[Respond] 📤 Sending content chunk to trigger thinking shrink');
            streamedTokens = true;
            yield ' ';
            
            // Log the accumulated thinking
            if (thinkingBuffer.trim()) {
              logThinking(thinkingBuffer.trim(), 'Chat (Streaming)');
              
              // Publish tool complete event
              if (thinkingPublisher) {
                await thinkingPublisher.publishComplete(
                  { reasoning: thinkingBuffer.trim() },
                  { 
                    characterCount: thinkingBuffer.length,
                    model: red.chatModel.model,
                  }
                );
              }
              
              // Store thinking separately in database
              if (generationId && conversationId) {
                const thinkingContent = thinkingBuffer.trim();
                try {
                  const db = await import('../lib/memory/database').then(m => m.getDatabase());
                  const thoughtId = await db.storeThought({
                    thoughtId: `thought_${generationId}_${Date.now()}`,
                    messageId, // IMPORTANT: Include messageId for linking to messages
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
            continue; // Recheck buffer after removing tag
          }
          
          // Process one character from buffer
          const char = pendingBuffer[0];
          pendingBuffer = pendingBuffer.slice(1);
          
          // Accumulate thinking or stream regular content
          if (inThinkingTag) {
            thinkingBuffer += char;
            
            // Publish streaming content via tool event system
            if (thinkingPublisher) {
              await thinkingPublisher.publishStreamingContent(char);
            }
            
            // Stream thinking character-by-character via Redis pub/sub
            if (messageId) {
              // Publish thinking chunk to Redis for real-time streaming
              await red.messageQueue.publishThinkingChunk(messageId, char);
              
              // Track that we've streamed thinking
              streamedThinking = true;
              
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
            
            // Log first content character after thinking ends
            if (streamedThinking && !streamedTokens) {
              console.log('[Respond] 📝 FIRST CONTENT CHARACTER after thinking:', JSON.stringify(char));
            }
            
            fullContent += char;
            streamedTokens = true;
            yield char; // Only stream non-thinking content
          }
        }
        
        // Log summary of what was processed in this chunk
        console.log(`[Respond] After chunk - pendingBuffer:${pendingBuffer.length}, inThinkingTag:${inThinkingTag}, thinking:${thinkingBuffer.length}chars, content:${fullContent.length}chars`);
      }
      // Capture the final message when LLM completes - use on_llm_end
      // Only from chat node
      if (event.event === "on_llm_end" && isChatNode) {
        // The AIMessage is nested in the generations array
        const generations = event.data?.output?.generations;
        if (generations && generations[0] && generations[0][0]?.message) {
          finalMessage = generations[0][0].message;
        }
      }
    }
    
    // CRITICAL: Flush remaining pending buffer (last 8 chars or less)
    console.log(`[Respond] 🔚 Stream ended - flushing pendingBuffer (${pendingBuffer.length} chars)`);
    while (pendingBuffer.length > 0) {
      const char = pendingBuffer[0];
      pendingBuffer = pendingBuffer.slice(1);
      
      if (inThinkingTag) {
        thinkingBuffer += char;
        if (messageId) {
          await red.messageQueue.publishThinkingChunk(messageId, char);
          streamedThinking = true;
          yield { _thinkingChunk: true, content: char };
        }
      } else {
        // Skip leading whitespace at the start of content
        if (!streamedTokens && (char === '\n' || char === '\r' || char === ' ')) {
          continue;
        }
        fullContent += char;
        streamedTokens = true;
        yield char;
      }
    }
    console.log(`[Respond] ✅ Flushed all pending content`);
    
    // If there's remaining thinking content at the end, log it
    if (thinkingBuffer.trim()) {
      logThinking(thinkingBuffer.trim(), 'Chat (Streaming)');
    }
    
    // If no tokens were streamed (e.g., when using tool calls like 'speak'),
    // get the final content and stream it character by character
    // BUT: Don't run this if we already streamed thinking, to avoid duplicate thinking events
    if (!streamedTokens && !streamedThinking && finalMessage && finalMessage.content) {
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
              messageId, // IMPORTANT: Include messageId for linking to messages
              conversationId,
              generationId,
              source: 'chat',
              content: thinking,
              timestamp: new Date(),
              metadata: {
                model: red.chatModel.model,
              },
            });
            console.log(`[Respond] Stored thinking: ${thoughtId} with messageId: ${messageId}`);
            
            // Publish to Redis for real-time updates  
            if (messageId) {
              console.log(`[Respond] Publishing non-stream thinking to Redis for messageId: ${messageId}, length: ${thinking.length}`);
              // Publish thinking content chunk by chunk for consistent display
              for (const char of thinking) {
                await red.messageQueue.publishThinkingChunk(messageId, char);
              }
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
        id: messageId, // Include the message ID for consistent linking
        role: 'assistant',
        content: fullContent,
        timestamp: Date.now(),
        toolExecutions: [] // TODO: Implement tool execution data collection
      });
      
      // Complete the generation
      await red.logger.completeGeneration(generationId, {
        response: fullContent,
        thinking: thinkingBuffer || undefined,
        route: (initialState as any).toolAction || 'chat',
        toolsUsed: (initialState as any).selectedTools,
        model: red.chatModel.model,
        tokens: finalMessage?.usage_metadata,
      });
      
      // Get message count for title generation
      const metadata = await red.memory.getMetadata(conversationId);
      const messageCount = metadata?.messageCount || 0;
      
      // Trigger background summarization (non-blocking)
      background.summarizeInBackground(conversationId, red.memory, red.chatModel);
      
      // Trigger background title generation (non-blocking)
      background.generateTitleInBackground(conversationId, messageCount, red.memory, red.chatModel);
      
      // Trigger executive summary generation after 3rd+ message (non-blocking)
      if (messageCount >= 3) {
        background.generateExecutiveSummaryInBackground(conversationId, red.memory, red.chatModel);
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
