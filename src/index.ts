/**
 * @file src/red.ts
 * @description The core library for the Red AI agent.
 */

// Load environment variables from .env early for library modules
import 'dotenv/config';

import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

import { redGraph } from "./lib/graphs/red";
import { MemoryManager } from "./lib/memory";
import { createGeminiModel, createLocalModel, createOpenAIModel } from "./lib/models";

// --- Type Definitions ---

/**
 * Defines the configuration required to initialize the Red instance.
 */
export interface RedConfig {
  redisUrl: string; // URL for connecting to the Redis instance, global state store
  vectorDbUrl: string; // URL for connecting to the vector database, short to medium term memory
  databaseUrl: string; // URL for connecting to the traditional database, long term memory
  defaultLlmUrl: string; // URL for the default local LLM (e.g., Ollama)
  llmEndpoints?: { [agentName: string]: string }; // Map of named agents to specific LLM endpoint URLs
}

/**
 * Defines optional parameters for on-demand invocations,
 * providing context about the request's origin.
 */
export interface InvokeOptions {
  source?: {
    device?: 'phone' | 'speaker' | 'web';
    application?: 'redHome' | 'redChat' | 'redAssistant';
  };
  stream?: boolean; // Flag to enable streaming responses
  conversationId?: string; // Optional conversation ID - will be auto-generated if not provided
}

// --- The Red Library Class ---

/**
 * The primary class for the Red AI engine. It encapsulates the agent's
 * core logic, state management, and interaction models.
 */
export class Red {
  private readonly config: RedConfig;
  private isLoaded: boolean = false;
  private isThinking: boolean = false;
  private baseState: object = {};
  private nodeId?: string;

  // Properties to hold the configured model instances
  public localModel!: ChatOllama;
  public openAIModel?: ChatOpenAI;
  public geminiModel?: ChatGoogleGenerativeAI;
  public memory!: MemoryManager;

  /**
   * Constructs a new instance of the Red AI engine.
   * @param config The configuration object required for initialization.
   */
  constructor(config: RedConfig) {
    this.config = config;

    // Initialize the model instances
    this.localModel = createLocalModel(config);
    this.openAIModel = createOpenAIModel();
    this.geminiModel = createGeminiModel();
    
    // Initialize memory manager
    this.memory = new MemoryManager(config.redisUrl);
  }

  // --- Private Internal Methods ---

  /**
   * The internal engine that executes a specified graph with the given state and options.
   * All graph-running logic is centralized here.
   * @private
   */
  private async _invoke(
    graphName: string,
    localState: object,
    options?: InvokeOptions
  ): Promise<any> {
    if (!this.isLoaded) {
      throw new Error("Red instance is not loaded. Please call load() before invoking a graph.");
    }
    
    // TODO: Implement the actual LangGraph execution logic.
    // This function will select a graph from a library based on `graphName`,
    // merge the `baseState` and `localState`, and execute the graph.
    
    const result = { 
      output: `Output from ${graphName}`,
      timestamp: new Date().toISOString()
    };
    
    return result;
  }

  // --- Public API ---

  /**
   * Initializes the Red instance by connecting to data sources and loading the base state.
   * This method must be called before any other operations.
   * @param nodeId An optional identifier for this specific instance, used for distributed systems.
   */
  public async load(nodeId?: string): Promise<void> {
    if (this.isLoaded) {
      return;
    }

    if (nodeId) {
      this.nodeId = nodeId;
    }

    console.log(`Loading base state for node: ${this.nodeId || 'primary'}...`);
    
    // TODO: Implement the actual state fetching logic from Redis using `this.config.redisUrl`.
    // The `nodeId` can be used to fetch a specific state for recovery or distributed operation.
    
    this.baseState = { loadedAt: new Date(), nodeId: this.nodeId };
    this.isLoaded = true;
    console.log('Base state loaded successfully.');
  }
  /**
   * Starts the autonomous, continuous "thinking" loop. The loop runs internally
   * until `stopThinking()` is called.
   */
  public async think(): Promise<void> {
    if (!this.isLoaded) {
      throw new Error("Red instance is not loaded. Please call load() before thinking.");
    }
    if (this.isThinking) {
      return;
    }

    this.isThinking = true;

    do {
      await this._invoke('cognitionGraph', { cycleType: 'autonomous' });
      
      // Delay between cycles to prevent runaway processes and manage resource usage.
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2-second delay
      
    } while (this.isThinking);
  }

  /**
   * Signals the internal `think()` loop to stop gracefully after completing its current cycle.
   */
  public stopThinking(): void {
    if (!this.isThinking) {
      return;
    }
    this.isThinking = false;
  }

  /**
   * Handles a direct, on-demand request from a user-facing application.
   * Automatically manages conversation history, memory, and summarization.
   * @param query The user's input or request data (must have a 'message' property)
   * @param options Metadata about the source of the request and conversation settings
   * @returns For non-streaming: the full AIMessage object with content, tokens, metadata, and conversationId.
   *          For streaming: an async generator that yields metadata first (with conversationId), then string chunks, then finally the full AIMessage.
   */
  public async respond(query: { message: string }, options: InvokeOptions = {}): Promise<any | AsyncGenerator<string | any, void, unknown>> {
    // Generate conversation ID if not provided
    const conversationId = options.conversationId || this.memory.generateConversationId(query.message);
    
    // Store user message in memory
    await this.memory.addMessage(conversationId, {
      role: 'user',
      content: query.message,
      timestamp: Date.now()
    });
    
    const initialState = {
      query,
      options: { ...options, conversationId }, // Ensure conversationId is in options
      redInstance: this, // Pass the entire instance into the graph
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
      return this._streamThroughGraphWithMemory(initialState, conversationId);
    } else {
      // Invoke the graph and return the full AIMessage
      const result = await redGraph.invoke(initialState);
      const response = result.response;
      
      // Store assistant response in memory
      await this.memory.addMessage(conversationId, {
        role: 'assistant',
        content: typeof response.content === 'string' ? response.content : JSON.stringify(response.content),
        timestamp: Date.now()
      });
      
      // Get message count for title generation
      const metadata = await this.memory.getMetadata(conversationId);
      const messageCount = metadata?.messageCount || 0;
      
      // Trigger background summarization (non-blocking)
      this._summarizeInBackground(conversationId);
      
      // Trigger background title generation (non-blocking)
      this._generateTitleInBackground(conversationId, messageCount);
      
      // Attach conversationId to response for server access
      return { ...response, conversationId };
    }
  }

  /**
   * Internal method to handle streaming responses through the graph with memory management.
   * Yields metadata first (with conversationId), then string chunks, then the final AIMessage object.
   * @private
   */
  private async *_streamThroughGraphWithMemory(initialState: any, conversationId: string): AsyncGenerator<string | any, void, unknown> {
    // Yield metadata first so server can capture conversationId immediately
    yield { _metadata: true, conversationId };
    
    // Use LangGraph's streamEvents to get token-level streaming
    const stream = redGraph.streamEvents(initialState, { version: "v1" });
    let finalMessage: any = null;
    let fullContent = '';
    let streamedTokens = false;
    
    for await (const event of stream) {
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
        const content = event.data.chunk.content;
        fullContent += content;
        streamedTokens = true;
        yield content;
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
    
    // If no tokens were streamed (e.g., when using tool calls like 'speak'),
    // get the final content and stream it character by character
    if (!streamedTokens && finalMessage && finalMessage.content) {
      fullContent = finalMessage.content;
      
      // Stream the content character by character for smooth UX
      const words = fullContent.split(' ');
      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        yield i === 0 ? word : ' ' + word;
        // Small delay for smooth streaming effect (optional)
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    
    // Store assistant response in memory (after streaming completes)
    if (fullContent) {
      await this.memory.addMessage(conversationId, {
        role: 'assistant',
        content: fullContent,
        timestamp: Date.now()
      });
      
      // Get message count for title generation
      const metadata = await this.memory.getMetadata(conversationId);
      const messageCount = metadata?.messageCount || 0;
      
      // Trigger background summarization (non-blocking)
      this._summarizeInBackground(conversationId);
      
      // Trigger background title generation (non-blocking)
      this._generateTitleInBackground(conversationId, messageCount);
      
      // Trigger executive summary generation after 3rd+ message (non-blocking)
      if (messageCount >= 3) {
        this._generateExecutiveSummaryInBackground(conversationId);
      }
    }
    
    // After all chunks are sent, yield the final AIMessage with complete token data
    if (finalMessage) {
      yield finalMessage;
    }
  }
  
  /**
   * Trigger summarization in background (non-blocking)
   * @private
   */
  private _summarizeInBackground(conversationId: string): void {
    this.memory.summarizeIfNeeded(conversationId, async (prompt) => {
      const response = await this.localModel.invoke([{ role: 'user', content: prompt }]);
      return response.content as string;
    }).catch(err => console.error('[Red] Summarization failed:', err));
  }

  /**
   * Generate executive summary in background (non-blocking)
   * Called after 3rd+ AI response
   * @private
   */
  private _generateExecutiveSummaryInBackground(conversationId: string): void {
    this.memory.generateExecutiveSummary(conversationId, async (prompt) => {
      const response = await this.localModel.invoke([{ role: 'user', content: prompt }]);
      return response.content as string;
    }).catch(err => console.error('[Red] Executive summary generation failed:', err));
  }

  /**
   * Generate a title for the conversation based on the first few messages
   * Runs after 2nd message (initial title) and 6th message (refined title)
   * @private
   */
  private async _generateTitleInBackground(conversationId: string, messageCount: number): Promise<void> {
    try {
      // Only generate title after 2nd or 6th message
      if (messageCount !== 2 && messageCount !== 6) {
        return;
      }

      // Check if title was manually set by user
      const metadata = await this.memory.getMetadata(conversationId);
      if (metadata?.titleSetByUser) {
        return; // Don't override user-set titles after 6th message
      }

      // Get recent messages for context
      const messages = await this.memory.getMessages(conversationId);
      const conversationText = messages
        .slice(0, Math.min(6, messages.length)) // Use first 6 messages max
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n');

      // Create prompt for title generation
      const titlePrompt = `Based on this conversation, generate a short, descriptive title (3-6 words max). Only respond with the title, nothing else:

${conversationText}`;

      // Generate title using LLM
      const response = await this.localModel.invoke([{ role: 'user', content: titlePrompt }]);
      const title = (response.content as string).trim().replace(/^["']|["']$/g, ''); // Remove quotes if any

      // Store title in metadata
      const metaKey = `conversation:${conversationId}:metadata`;
      await this.memory['redis'].hset(metaKey, 'title', title);
      
      console.log(`[Red] Generated title for ${conversationId}: "${title}"`);
    } catch (err) {
      console.error('[Red] Title generation failed:', err);
    }
  }

  /**
   * Set a custom title for a conversation (set by user)
   * This prevents automatic title generation from overwriting it
   * @param conversationId The conversation ID
   * @param title The custom title to set
   */
  public async setConversationTitle(conversationId: string, title: string): Promise<void> {
    const metaKey = `conversation:${conversationId}:metadata`;
    await this.memory['redis'].hset(metaKey, {
      'title': title,
      'titleSetByUser': 'true'
    });
    console.log(`[Red] User set title for ${conversationId}: "${title}"`);
  }

  /**
   * Get the title for a conversation
   * @param conversationId The conversation ID
   * @returns The title or null if not set
   */
  public async getConversationTitle(conversationId: string): Promise<string | null> {
    const metadata = await this.memory.getMetadata(conversationId);
    return metadata?.title || null;
  }

}