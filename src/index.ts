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
   * @returns A promise that resolves with the response string.
   */
  public async respond(query: object, options: InvokeOptions): Promise<{ response: string }> {
    console.log("--- Responding to a direct request ---");
    
    const initialState = {
      query,
      options,
      redInstance: this, // Pass the entire instance into the graph
    };

    // Invoke the graph and extract only the response field
    const result = await redGraph.invoke(initialState);
    
    // Return only the response, not the entire internal state
    return { response: result.response };
  }

  /**
   * Handles a direct, on-demand request with streaming responses.
   * Streams tokens directly from the LLM as they are generated.
   * @param query The user's input or request data.
   * @param options Metadata about the source of the request for routing purposes.
   * @returns An async generator that yields response chunks as they arrive.
   */
  public async *respondStream(query: object, options: InvokeOptions): AsyncGenerator<string, void, unknown> {
    console.log("--- Responding to a direct request (streaming) ---");
    
    // For streaming, bypass the graph and stream directly from the model
    // This gives us token-by-token streaming instead of node-by-node
    const userText = (query && (query as any).message) ? (query as any).message : JSON.stringify(query || {});
    
    const stream = await this.localModel.stream([
      { role: "user", content: userText }
    ]);
    
    for await (const chunk of stream) {
      if (chunk.content && typeof chunk.content === 'string') {
        yield chunk.content;
      }
    }
  }
}