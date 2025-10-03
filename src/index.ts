/**
 * @file src/red.ts
 * @description The core library for the Red AI agent.
 */

import { ChatOllama } from "@langchain/ollama";
import { createLocalModel, createOpenAIModel } from "./lib/models";
import { ChatOpenAI } from "@langchain/openai";
import { redGraph } from "./lib/graphs/red";

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

  /**
   * Constructs a new instance of the Red AI engine.
   * @param config The configuration object required for initialization.
   */
  constructor(config: RedConfig) {
    this.config = config;

    // Initialize the model instances
    this.localModel = createLocalModel(config);
    this.openAIModel = createOpenAIModel();
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
    
    console.log(`[Node: ${this.nodeId || 'primary'}] Invoking graph: ${graphName}...`);
    
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
      console.warn("Red instance is already loaded.");
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
      console.warn("The think() loop is already running.");
      return;
    }

    this.isThinking = true;
    console.log("--- Starting continuous 'think' loop ---");

    do {
      await this._invoke('cognitionGraph', { cycleType: 'autonomous' });
      
      // Delay between cycles to prevent runaway processes and manage resource usage.
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2-second delay
      
    } while (this.isThinking);

    console.log("--- 'Think' loop has stopped. ---");
  }

  /**
   * Signals the internal `think()` loop to stop gracefully after completing its current cycle.
   */
  public stopThinking(): void {
    if (!this.isThinking) {
      console.log("Think loop is not currently running.");
      return;
    }
    console.log("Signaling the think() loop to stop...");
    this.isThinking = false;
  }

  /**
   * Handles a direct, on-demand request from a user-facing application.
   * @param query The user's input or request data.
   * @param options Metadata about the source of the request for routing purposes.
   * @returns For non-streaming: the full AIMessage object with content, tokens, and metadata.
   *          For streaming: an async generator that yields string chunks, then finally yields the full AIMessage.
   */
  public async respond(query: object, options: InvokeOptions): Promise<any | AsyncGenerator<string | any, void, unknown>> {
    console.log("--- Responding to a direct request ---");
    
    const initialState = {
      query,
      options,
      redInstance: this, // Pass the entire instance into the graph
    };

    // Check if streaming is requested
    if (options.stream) {
      // Use LangGraph's streaming capabilities to stream through the graph
      return this._streamThroughGraph(initialState);
    } else {
      // Invoke the graph and return the full AIMessage
      const result = await redGraph.invoke(initialState);
      
      // Return the full AIMessage object directly
      return result.response;
    }
  }

  /**
   * Internal method to handle streaming responses through the graph.
   * Yields string chunks as they arrive, then yields the final AIMessage object with complete metadata.
   * @private
   */
  private async *_streamThroughGraph(initialState: any): AsyncGenerator<string | any, void, unknown> {
    // Use LangGraph's streamEvents to get token-level streaming
    const stream = redGraph.streamEvents(initialState, { version: "v1" });
    let finalMessage: any = null;
    
    for await (const event of stream) {
      // Yield streaming content chunks
      if (event.event === "on_llm_stream" && event.data?.chunk?.content) {
        yield event.data.chunk.content;
      }
      // Capture the final message when LLM completes - use on_llm_end
      if (event.event === "on_llm_end") {
        // The AIMessage is nested in the generations array
        const generations = event.data?.output?.generations;
        if (generations && generations[0] && generations[0][0]?.message) {
          finalMessage = generations[0][0].message;
        }
      }
    }
    
    // After all chunks are sent, yield the final AIMessage with complete token data
    if (finalMessage) {
      yield finalMessage;
    }
  }

}