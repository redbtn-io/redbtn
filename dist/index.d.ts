/**
 * @file src/red.ts
 * @description The core library for the Red AI agent.
 */
import 'dotenv/config';
import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { MemoryManager } from "./lib/memory/memory";
import { MessageQueue } from "./lib/memory/queue";
import { PersistentLogger } from "./lib/logs/persistent-logger";
import { McpRegistry } from "./lib/mcp/registry";
import { GraphRegistry } from "./lib/graphs/GraphRegistry";
import { NeuronRegistry } from "./lib/neurons/NeuronRegistry";
import { RedLog } from "@redbtn/redlog";
export { getDatabase, resetDatabase, DatabaseManager, StoredMessage, Conversation, StoredLog, Generation, BaseDocument, } from "./lib/memory/database";
export { MessageQueue, MessageGenerationState } from "./lib/memory/queue";
export * from "./lib/logs";
export { PersistentLogger } from "./lib/logs/persistent-logger";
export { extractThinking, logThinking, extractAndLogThinking } from "./lib/utils/thinking";
export { VectorStoreManager, DocumentChunk, SearchResult, ChunkingConfig, SearchConfig, CollectionStats } from "./lib/memory/vectors";
export { addToVectorStoreNode, retrieveFromVectorStoreNode } from "./lib/nodes/rag";
export { McpClient, McpRegistry, McpServer, WebServerSSE as WebServer, SystemServerSSE as SystemServer, Tool, CallToolResult, ServerRegistration, } from "./lib/mcp";
export { universalNodeRegistry } from "../dist/lib/registry/UniversalNodeRegistry";
export { run, isStreamingResult } from "./functions/run";
export type { RunOptions, RunResult, StreamingRunResult, ConnectionFetcher } from "./functions/run";
export { RunKeys } from "./lib/run/types";
export type { AudioChunkEvent } from "./lib/run/types";
export { getRunState, getActiveRunForConversation } from "./lib/run/run-publisher";
export { TtsChunker, findBreakPoint, synthesize, isTtsAvailable, AudioStreamPipeline } from './lib/tts';
export { transcribe, isSttAvailable, VoiceClient } from './lib/tts';
export type { SynthesizeOptions, AudioStreamPipelineOptions, TranscribeOptions, TranscribeResult, VoiceClientOptions } from './lib/tts';
export { ConversationPublisher, createConversationPublisher, ConversationKeys } from './lib/conversation';
export type { ConversationEvent } from './lib/conversation';
/**
 * Defines the configuration required to initialize the Red instance.
 */
export interface RedConfig {
    redisUrl: string;
    vectorDbUrl: string;
    databaseUrl: string;
    llmEndpoints?: {
        [agentName: string]: string;
    };
    /** @deprecated LLM endpoints are now configured via neuron configs in MongoDB. Use neuronRegistry instead. */
    chatLlmUrl?: string;
    /** @deprecated LLM endpoints are now configured via neuron configs in MongoDB. Use neuronRegistry instead. */
    workLlmUrl?: string;
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
    stream?: boolean;
    conversationId?: string;
    generationId?: string;
    messageId?: string;
    userMessageId?: string;
}
/**
 * The primary class for the Red AI engine. It encapsulates the agent's
 * core logic, state management, and interaction models.
 */
export declare class Red {
    private readonly config;
    private isLoaded;
    private isThinking;
    private baseState;
    private nodeId?;
    private heartbeatInterval?;
    /**
     * @deprecated Use neuronRegistry.getModel() instead.
     * LLM endpoints are now configured via neuron configs in MongoDB.
     * This property is no longer initialized -- accessing it will throw at runtime.
     */
    chatModel: ChatOllama;
    /**
     * @deprecated Use neuronRegistry.getModel() instead.
     * LLM endpoints are now configured via neuron configs in MongoDB.
     * This property is no longer initialized -- accessing it will throw at runtime.
     */
    workerModel: ChatOllama;
    openAIModel?: ChatOpenAI;
    geminiModel?: ChatGoogleGenerativeAI;
    memory: MemoryManager;
    messageQueue: MessageQueue;
    logger: PersistentLogger;
    redlog: RedLog;
    mcpRegistry: McpRegistry;
    graphRegistry: GraphRegistry;
    neuronRegistry: NeuronRegistry;
    log: any;
    redis: any;
    /**
     * Constructs a new instance of the Red AI engine.
     * @param config The configuration object required for initialization.
     */
    constructor(config: RedConfig);
    /**
     * The internal engine that executes a specified graph with the given state and options.
     * All graph-running logic is centralized here.
     * @private
     */
    private _invoke;
    /**
     * Initializes the Red instance by connecting to data sources and loading the base state.
     * This method must be called before any other operations.
     * @param nodeId An optional identifier for this specific instance, used for distributed systems.
     */
    load(nodeId?: string): Promise<void>;
    /**
     * Gets a list of all currently active nodes.
     * @returns Array of active node IDs
     */
    getActiveNodes(): Promise<string[]>;
    /**
     * Starts the autonomous, continuous "thinking" loop. The loop runs internally
     * until `stopThinking()` is called.
     */
    think(): Promise<void>;
    /**
     * Signals the internal `think()` loop to stop gracefully after completing its current cycle.
     */
    stopThinking(): void;
    /**
     * Gracefully shuts down the Red instance, stopping heartbeat and cleaning up resources.
     */
    shutdown(): Promise<void>;
    /**
     * Handles a direct, on-demand request from a user-facing application.
     * Automatically manages conversation history, memory, and summarization.
     * @param query The user's input or request data (must have a 'message' property)
     * @param options Metadata about the source of the request and conversation settings
     * @returns For non-streaming: the full AIMessage object with content, tokens, metadata, and conversationId.
     *          For streaming: an async generator that yields metadata first (with conversationId), then string chunks, then finally the full AIMessage.
     */
    respond(query: {
        message: string;
    }, options?: InvokeOptions): Promise<any | AsyncGenerator<string | any, void, unknown>>;
    /**
     * Set a custom title for a conversation (set by user)
     * This prevents automatic title generation from overwriting it
     * @param conversationId The conversation ID
     * @param title The custom title to set
     */
    setConversationTitle(conversationId: string, title: string): Promise<void>;
    /**
     * Get the title for a conversation
     * @param conversationId The conversation ID
     * @returns The title or null if not set
     */
    getConversationTitle(conversationId: string): Promise<string | null>;
    /**
     * Call an MCP tool by name with comprehensive logging
     * Automatically routes to the correct MCP server
     * @param toolName The name of the tool to call
     * @param args The arguments to pass to the tool
     * @param context Optional logging context (conversationId, generationId, messageId)
     * @returns The tool execution result
     */
    callMcpTool(toolName: string, args: Record<string, unknown>, context?: {
        conversationId?: string;
        generationId?: string;
        messageId?: string;
        credentials?: any;
    }): Promise<any>;
    /**
     * Sanitize arguments for logging (remove sensitive data, truncate long values)
     */
    private sanitizeArgsForLogging;
    /**
     * Get all available MCP tools
     * @returns Array of available tools with their server info
     */
    getMcpTools(): Array<{
        server: string;
        tool: any;
    }>;
}
