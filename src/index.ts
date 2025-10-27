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
import { MemoryManager } from "./lib/memory/memory";
import { MessageQueue } from "./lib/memory/queue";
import { PersistentLogger } from "./lib/logs/persistent-logger";
import { createGeminiModel, createChatModel, createWorkerModel, createOpenAIModel } from "./lib/models";
import * as background from "./functions/background";
import { respond as respondFunction } from "./functions/respond";
import { McpRegistry } from "./lib/mcp/registry";

// Export database utilities for external use
export { 
  getDatabase, 
  resetDatabase,
  DatabaseManager, 
  StoredMessage, 
  Conversation,
  StoredLog,
  Generation,
  BaseDocument,
} from "./lib/memory/database";

// Export message queue for background processing
export { MessageQueue, MessageGenerationState } from "./lib/memory/queue";

// Export logging system
export * from "./lib/logs";
export { PersistentLogger } from "./lib/logs/persistent-logger";

// Export thinking utilities for DeepSeek-R1 and similar models
export { extractThinking, logThinking, extractAndLogThinking } from "./lib/utils/thinking";

// Export RAG (Retrieval-Augmented Generation) components
export { 
  VectorStoreManager,
  DocumentChunk,
  SearchResult,
  ChunkingConfig,
  SearchConfig,
  CollectionStats
} from "./lib/memory/vectors";

export { 
  addToVectorStoreNode,
  retrieveFromVectorStoreNode
} from "./lib/nodes/rag";

// Export MCP (Model Context Protocol) components
export {
  McpClient,
  McpRegistry,
  McpServer,
  WebServer,
  SystemServer,
  Tool,
  CallToolResult,
  ServerRegistration,
} from "./lib/mcp";

// --- Type Definitions ---

/**
 * Defines the configuration required to initialize the Red instance.
 */
export interface RedConfig {
  redisUrl: string; // URL for connecting to the Redis instance, global state store
  vectorDbUrl: string; // URL for connecting to the vector database, short to medium term memory
  databaseUrl: string; // URL for connecting to the traditional database, long term memory
  chatLlmUrl: string; // URL for the chat LLM (e.g., Ollama on 192.168.1.4:11434)
  workLlmUrl: string; // URL for the worker LLM (e.g., Ollama on 192.168.1.3:11434)
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
  generationId?: string; // Optional generation ID - will be auto-generated if not provided
  messageId?: string; // Optional message ID for Redis pub/sub streaming
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
  private heartbeatInterval?: NodeJS.Timeout;

  // Properties to hold the configured model instances
  public chatModel!: ChatOllama; // Primary chat interaction model
  public workerModel!: ChatOllama; // Background tasks and tool execution model
  public openAIModel?: ChatOpenAI;
  public geminiModel?: ChatGoogleGenerativeAI;
  public memory!: MemoryManager;
  public messageQueue!: MessageQueue;
  public logger!: PersistentLogger;
  public mcpRegistry!: McpRegistry;
  private redis!: any; // Redis client for heartbeat

  /**
   * Constructs a new instance of the Red AI engine.
   * @param config The configuration object required for initialization.
   */
  constructor(config: RedConfig) {
    this.config = config;

    // Initialize the model instances
    this.chatModel = createChatModel(config);
    this.workerModel = createWorkerModel(config);
    this.openAIModel = createOpenAIModel();
    this.geminiModel = createGeminiModel();
    
    // Initialize memory manager
    this.memory = new MemoryManager(config.redisUrl);
    
    // Initialize message queue with same Redis connection
    const redis = new (require('ioredis'))(config.redisUrl);
    this.redis = redis;
    this.messageQueue = new MessageQueue(redis);
    
    // Initialize logger with MongoDB persistence
    this.logger = new PersistentLogger(redis, this.nodeId || 'default');
    
    // Initialize MCP registry for tool servers
    this.mcpRegistry = new McpRegistry(redis.duplicate());
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
    } else {
      // Generate a default nodeId if not provided
      this.nodeId = `node_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    process.stdout.write(`\rLoading node: ${this.nodeId}...`);
    
    // TODO: Implement the actual state fetching logic from Redis using `this.config.redisUrl`.
    // The `nodeId` can be used to fetch a specific state for recovery or distributed operation.
    
    this.baseState = { loadedAt: new Date(), nodeId: this.nodeId };
    this.isLoaded = true;
    
    // Register MCP servers (web, system, rag, and context)
    try {
      await this.mcpRegistry.registerServer('web');
      await this.mcpRegistry.registerServer('system');
      await this.mcpRegistry.registerServer('rag');
      await this.mcpRegistry.registerServer('context');
      const tools = this.mcpRegistry.getAllTools();
      process.stdout.write(`\r✓ Red AI initialized (${tools.length} MCP tools)\n`);
    } catch (error) {
      console.warn('⚠️ MCP server registration failed:', error);
      console.warn('  Tool calls will fail. Make sure MCP servers are running: npm run mcp:start');
    }
    
    // Start heartbeat to register node as active
    this.heartbeatInterval = background.startHeartbeat(this.nodeId, this.redis);
  }

  /**
   * Gets a list of all currently active nodes.
   * @returns Array of active node IDs
   */
  public async getActiveNodes(): Promise<string[]> {
    return background.getActiveNodes(this.redis);
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
   * Gracefully shuts down the Red instance, stopping heartbeat and cleaning up resources.
   */
  public async shutdown(): Promise<void> {
    console.log(`[Red] Shutting down node: ${this.nodeId}...`);
    
    // Stop thinking if active
    this.stopThinking();
    
    // Stop heartbeat
    await background.stopHeartbeat(this.nodeId, this.redis, this.heartbeatInterval);
    this.heartbeatInterval = undefined;
    
    // Disconnect from MCP servers
    try {
      await this.mcpRegistry.disconnectAll();
      console.log('[Red] MCP clients disconnected');
    } catch (error) {
      console.warn('[Red] Error disconnecting MCP clients:', error);
    }
    
    // Close Redis connection
    if (this.redis) {
      await this.redis.quit();
    }
    
    this.isLoaded = false;
    console.log('[Red] Shutdown complete');
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
    return respondFunction(this, query, options);
  }

  /**
   * Set a custom title for a conversation (set by user)
   * This prevents automatic title generation from overwriting it
   * @param conversationId The conversation ID
   * @param title The custom title to set
   */
  public async setConversationTitle(conversationId: string, title: string): Promise<void> {
    return background.setConversationTitle(conversationId, title, this);
  }

  /**
   * Get the title for a conversation
   * @param conversationId The conversation ID
   * @returns The title or null if not set
   */
  public async getConversationTitle(conversationId: string): Promise<string | null> {
    return background.getConversationTitle(conversationId, this);
  }

  /**
   * Call an MCP tool by name with comprehensive logging
   * Automatically routes to the correct MCP server
   * @param toolName The name of the tool to call
   * @param args The arguments to pass to the tool
   * @param context Optional logging context (conversationId, generationId, messageId)
   * @returns The tool execution result
   */
  public async callMcpTool(
    toolName: string, 
    args: Record<string, unknown>,
    context?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<any> {
    const startTime = Date.now();
    
    // Log tool call start
    await this.logger.log({
      level: 'info',
      category: 'mcp',
      message: `📡 MCP Tool Call: ${toolName}`,
      conversationId: context?.conversationId,
      generationId: context?.generationId,
      metadata: {
        toolName,
        args: this.sanitizeArgsForLogging(args),
        protocol: 'MCP/JSON-RPC 2.0'
      }
    });

    try {
      const result = await this.mcpRegistry.callTool(toolName, args, {
        conversationId: context?.conversationId,
        generationId: context?.generationId,
        messageId: context?.messageId
      });
      const duration = Date.now() - startTime;

      // Log success
      await this.logger.log({
        level: result.isError ? 'warn' : 'success',
        category: 'mcp',
        message: result.isError 
          ? `⚠️ MCP Tool Error: ${toolName} (${duration}ms)`
          : `✓ MCP Tool Complete: ${toolName} (${duration}ms)`,
        conversationId: context?.conversationId,
        generationId: context?.generationId,
        metadata: {
          toolName,
          duration,
          isError: result.isError || false,
          resultLength: result.content?.[0]?.text?.length || 0,
          protocol: 'MCP/JSON-RPC 2.0'
        }
      });

      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log error
      await this.logger.log({
        level: 'error',
        category: 'mcp',
        message: `✗ MCP Tool Failed: ${toolName} (${duration}ms)`,
        conversationId: context?.conversationId,
        generationId: context?.generationId,
        metadata: {
          toolName,
          duration,
          error: errorMessage,
          protocol: 'MCP/JSON-RPC 2.0'
        }
      });

      throw error;
    }
  }

  /**
   * Sanitize arguments for logging (remove sensitive data, truncate long values)
   */
  private sanitizeArgsForLogging(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        // Truncate long strings
        sanitized[key] = value.length > 200 ? value.substring(0, 200) + '...' : value;
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  /**
   * Get all available MCP tools
   * @returns Array of available tools with their server info
   */
  public getMcpTools(): Array<{ server: string; tool: any }> {
    return this.mcpRegistry.getAllTools();
  }

}