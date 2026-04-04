"use strict";
/**
 * @file src/red.ts
 * @description The core library for the Red AI agent.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Red = exports.ConversationKeys = exports.createConversationPublisher = exports.ConversationPublisher = exports.VoiceClient = exports.isSttAvailable = exports.transcribe = exports.AudioStreamPipeline = exports.isTtsAvailable = exports.synthesize = exports.findBreakPoint = exports.TtsChunker = exports.getActiveRunForConversation = exports.getRunState = exports.RunKeys = exports.isStreamingResult = exports.run = exports.universalNodeRegistry = exports.SystemServer = exports.WebServer = exports.McpServer = exports.McpRegistry = exports.McpClient = exports.retrieveFromVectorStoreNode = exports.addToVectorStoreNode = exports.VectorStoreManager = exports.extractAndLogThinking = exports.logThinking = exports.extractThinking = exports.PersistentLogger = exports.MessageQueue = exports.DatabaseManager = exports.resetDatabase = exports.getDatabase = void 0;
// Load environment variables from .env early for library modules
require("dotenv/config");
const memory_1 = require("./lib/memory/memory");
const queue_1 = require("./lib/memory/queue");
const persistent_logger_1 = require("./lib/logs/persistent-logger");
const models_1 = require("./lib/models");
const background = __importStar(require("./functions/background"));
const respond_1 = require("./functions/respond");
const registry_1 = require("./lib/mcp/registry");
const GraphRegistry_1 = require("./lib/graphs/GraphRegistry");
const NeuronRegistry_1 = require("./lib/neurons/NeuronRegistry");
const logger_1 = require("./lib/utils/logger");
const redlog_1 = require("@redbtn/redlog");
// Export database utilities for external use
var database_1 = require("./lib/memory/database");
Object.defineProperty(exports, "getDatabase", { enumerable: true, get: function () { return database_1.getDatabase; } });
Object.defineProperty(exports, "resetDatabase", { enumerable: true, get: function () { return database_1.resetDatabase; } });
Object.defineProperty(exports, "DatabaseManager", { enumerable: true, get: function () { return database_1.DatabaseManager; } });
// Export message queue for background processing
var queue_2 = require("./lib/memory/queue");
Object.defineProperty(exports, "MessageQueue", { enumerable: true, get: function () { return queue_2.MessageQueue; } });
// Export logging system
__exportStar(require("./lib/logs"), exports);
var persistent_logger_2 = require("./lib/logs/persistent-logger");
Object.defineProperty(exports, "PersistentLogger", { enumerable: true, get: function () { return persistent_logger_2.PersistentLogger; } });
// Export thinking utilities for DeepSeek-R1 and similar models
var thinking_1 = require("./lib/utils/thinking");
Object.defineProperty(exports, "extractThinking", { enumerable: true, get: function () { return thinking_1.extractThinking; } });
Object.defineProperty(exports, "logThinking", { enumerable: true, get: function () { return thinking_1.logThinking; } });
Object.defineProperty(exports, "extractAndLogThinking", { enumerable: true, get: function () { return thinking_1.extractAndLogThinking; } });
// Export RAG (Retrieval-Augmented Generation) components
var vectors_1 = require("./lib/memory/vectors");
Object.defineProperty(exports, "VectorStoreManager", { enumerable: true, get: function () { return vectors_1.VectorStoreManager; } });
var rag_1 = require("./lib/nodes/rag");
Object.defineProperty(exports, "addToVectorStoreNode", { enumerable: true, get: function () { return rag_1.addToVectorStoreNode; } });
Object.defineProperty(exports, "retrieveFromVectorStoreNode", { enumerable: true, get: function () { return rag_1.retrieveFromVectorStoreNode; } });
// Export MCP (Model Context Protocol) components
var mcp_1 = require("./lib/mcp");
Object.defineProperty(exports, "McpClient", { enumerable: true, get: function () { return mcp_1.McpClient; } });
Object.defineProperty(exports, "McpRegistry", { enumerable: true, get: function () { return mcp_1.McpRegistry; } });
Object.defineProperty(exports, "McpServer", { enumerable: true, get: function () { return mcp_1.McpServer; } });
Object.defineProperty(exports, "WebServer", { enumerable: true, get: function () { return mcp_1.WebServerSSE; } });
Object.defineProperty(exports, "SystemServer", { enumerable: true, get: function () { return mcp_1.SystemServerSSE; } });
// Export registries
var UniversalNodeRegistry_1 = require("../dist/lib/registry/UniversalNodeRegistry");
Object.defineProperty(exports, "universalNodeRegistry", { enumerable: true, get: function () { return UniversalNodeRegistry_1.universalNodeRegistry; } });
// Export graph execution
var run_1 = require("./functions/run");
Object.defineProperty(exports, "run", { enumerable: true, get: function () { return run_1.run; } });
Object.defineProperty(exports, "isStreamingResult", { enumerable: true, get: function () { return run_1.isStreamingResult; } });
// Export run utilities (used by SSE stream endpoints)
var types_1 = require("./lib/run/types");
Object.defineProperty(exports, "RunKeys", { enumerable: true, get: function () { return types_1.RunKeys; } });
var run_publisher_1 = require("./lib/run/run-publisher");
Object.defineProperty(exports, "getRunState", { enumerable: true, get: function () { return run_publisher_1.getRunState; } });
Object.defineProperty(exports, "getActiveRunForConversation", { enumerable: true, get: function () { return run_publisher_1.getActiveRunForConversation; } });
// Export TTS / Voice utilities
var tts_1 = require("./lib/tts");
Object.defineProperty(exports, "TtsChunker", { enumerable: true, get: function () { return tts_1.TtsChunker; } });
Object.defineProperty(exports, "findBreakPoint", { enumerable: true, get: function () { return tts_1.findBreakPoint; } });
Object.defineProperty(exports, "synthesize", { enumerable: true, get: function () { return tts_1.synthesize; } });
Object.defineProperty(exports, "isTtsAvailable", { enumerable: true, get: function () { return tts_1.isTtsAvailable; } });
Object.defineProperty(exports, "AudioStreamPipeline", { enumerable: true, get: function () { return tts_1.AudioStreamPipeline; } });
var tts_2 = require("./lib/tts");
Object.defineProperty(exports, "transcribe", { enumerable: true, get: function () { return tts_2.transcribe; } });
Object.defineProperty(exports, "isSttAvailable", { enumerable: true, get: function () { return tts_2.isSttAvailable; } });
Object.defineProperty(exports, "VoiceClient", { enumerable: true, get: function () { return tts_2.VoiceClient; } });
// Export conversation streaming
var conversation_1 = require("./lib/conversation");
Object.defineProperty(exports, "ConversationPublisher", { enumerable: true, get: function () { return conversation_1.ConversationPublisher; } });
Object.defineProperty(exports, "createConversationPublisher", { enumerable: true, get: function () { return conversation_1.createConversationPublisher; } });
Object.defineProperty(exports, "ConversationKeys", { enumerable: true, get: function () { return conversation_1.ConversationKeys; } });
// --- The Red Library Class ---
/**
 * The primary class for the Red AI engine. It encapsulates the agent's
 * core logic, state management, and interaction models.
 */
class Red {
    /**
     * Constructs a new instance of the Red AI engine.
     * @param config The configuration object required for initialization.
     */
    constructor(config) {
        this.isLoaded = false;
        this.isThinking = false;
        this.baseState = {};
        this.config = config;
        // Initialize optional model instances (OpenAI, Gemini)
        // Note: chatModel and workerModel are deprecated. The neuron system in MongoDB
        // is now the source of truth for LLM endpoints. Use neuronRegistry.getModel() instead.
        // These properties are intentionally left uninitialized.
        this.openAIModel = (0, models_1.createOpenAIModel)();
        this.geminiModel = (0, models_1.createGeminiModel)();
        // Initialize memory manager
        this.memory = new memory_1.MemoryManager(config.redisUrl);
        // Initialize message queue with same Redis connection
        const redis = new (require('ioredis'))(config.redisUrl);
        this.redis = redis;
        this.messageQueue = new queue_1.MessageQueue(redis);
        // Initialize logger with MongoDB persistence
        this.logger = new persistent_logger_1.PersistentLogger(redis, this.nodeId || 'default');
        // Initialize RedLog for structured logging via @redbtn/redlog (used by RunPublisher)
        this.redlog = redlog_1.RedLog.create({
            redisUrl: config.redisUrl,
            mongoUri: config.databaseUrl,
            prefix: 'redlog',
            namespace: 'run',
            console: false,
        });
        // Initialize MCP registry for tool servers (pass messageQueue for event publishing)
        this.mcpRegistry = new registry_1.McpRegistry(this.messageQueue);
        // Initialize graph and neuron registries for run() execution
        this.graphRegistry = new GraphRegistry_1.GraphRegistry({ databaseUrl: config.databaseUrl });
        this.neuronRegistry = new NeuronRegistry_1.NeuronRegistry({ databaseUrl: config.databaseUrl });
        this.log = (0, logger_1.createLogger)('Red');
    }
    // --- Private Internal Methods ---
    /**
     * The internal engine that executes a specified graph with the given state and options.
     * All graph-running logic is centralized here.
     * @private
     */
    _invoke(graphName, localState, options) {
        return __awaiter(this, void 0, void 0, function* () {
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
        });
    }
    // --- Public API ---
    /**
     * Initializes the Red instance by connecting to data sources and loading the base state.
     * This method must be called before any other operations.
     * @param nodeId An optional identifier for this specific instance, used for distributed systems.
     */
    load(nodeId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.isLoaded) {
                return;
            }
            if (nodeId) {
                this.nodeId = nodeId;
            }
            else {
                // Generate a default nodeId if not provided
                this.nodeId = `node_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            }
            process.stdout.write(`\rLoading node: ${this.nodeId}...`);
            // TODO: Implement the actual state fetching logic from Redis using `this.config.redisUrl`.
            // The `nodeId` can be used to fetch a specific state for recovery or distributed operation.
            this.baseState = { loadedAt: new Date(), nodeId: this.nodeId };
            this.isLoaded = true;
            // Register MCP servers (SSE transport on different ports)
            try {
                yield this.mcpRegistry.registerServer({ name: 'web', url: 'http://localhost:3001/mcp' });
                yield this.mcpRegistry.registerServer({ name: 'system', url: 'http://localhost:3002/mcp' });
                yield this.mcpRegistry.registerServer({ name: 'rag', url: 'http://localhost:3003/mcp' });
                yield this.mcpRegistry.registerServer({ name: 'context', url: 'http://localhost:3004/mcp' });
                const tools = this.mcpRegistry.getAllTools();
                process.stdout.write(`\r✓ Red AI initialized (${tools.length} MCP tools)\n`);
            }
            catch (error) {
                console.warn('⚠️ MCP server registration failed:', error);
                console.warn('  Tool calls will fail. Make sure MCP servers are running: npm run mcp:start');
            }
            // Start heartbeat to register node as active
            this.heartbeatInterval = background.startHeartbeat(this.nodeId, this.redis);
        });
    }
    /**
     * Gets a list of all currently active nodes.
     * @returns Array of active node IDs
     */
    getActiveNodes() {
        return __awaiter(this, void 0, void 0, function* () {
            return background.getActiveNodes(this.redis);
        });
    }
    /**
     * Starts the autonomous, continuous "thinking" loop. The loop runs internally
     * until `stopThinking()` is called.
     */
    think() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.isLoaded) {
                throw new Error("Red instance is not loaded. Please call load() before thinking.");
            }
            if (this.isThinking) {
                return;
            }
            this.isThinking = true;
            do {
                yield this._invoke('cognitionGraph', { cycleType: 'autonomous' });
                // Delay between cycles to prevent runaway processes and manage resource usage.
                yield new Promise(resolve => setTimeout(resolve, 2000)); // 2-second delay
            } while (this.isThinking);
        });
    }
    /**
     * Signals the internal `think()` loop to stop gracefully after completing its current cycle.
     */
    stopThinking() {
        if (!this.isThinking) {
            return;
        }
        this.isThinking = false;
    }
    /**
     * Gracefully shuts down the Red instance, stopping heartbeat and cleaning up resources.
     */
    shutdown() {
        return __awaiter(this, void 0, void 0, function* () {
            console.log(`[Red] Shutting down node: ${this.nodeId}...`);
            // Stop thinking if active
            this.stopThinking();
            // Stop heartbeat
            yield background.stopHeartbeat(this.nodeId, this.redis, this.heartbeatInterval);
            this.heartbeatInterval = undefined;
            // Disconnect from MCP servers
            try {
                yield this.mcpRegistry.disconnectAll();
                console.log('[Red] MCP clients disconnected');
            }
            catch (error) {
                console.warn('[Red] Error disconnecting MCP clients:', error);
            }
            // Close Redis connection
            if (this.redis) {
                yield this.redis.quit();
            }
            this.isLoaded = false;
            console.log('[Red] Shutdown complete');
        });
    }
    /**
     * Handles a direct, on-demand request from a user-facing application.
     * Automatically manages conversation history, memory, and summarization.
     * @param query The user's input or request data (must have a 'message' property)
     * @param options Metadata about the source of the request and conversation settings
     * @returns For non-streaming: the full AIMessage object with content, tokens, metadata, and conversationId.
     *          For streaming: an async generator that yields metadata first (with conversationId), then string chunks, then finally the full AIMessage.
     */
    respond(query_1) {
        return __awaiter(this, arguments, void 0, function* (query, options = {}) {
            return (0, respond_1.respond)(this, query, options);
        });
    }
    /**
     * Set a custom title for a conversation (set by user)
     * This prevents automatic title generation from overwriting it
     * @param conversationId The conversation ID
     * @param title The custom title to set
     */
    setConversationTitle(conversationId, title) {
        return __awaiter(this, void 0, void 0, function* () {
            return background.setConversationTitle(conversationId, title, this);
        });
    }
    /**
     * Get the title for a conversation
     * @param conversationId The conversation ID
     * @returns The title or null if not set
     */
    getConversationTitle(conversationId) {
        return __awaiter(this, void 0, void 0, function* () {
            return background.getConversationTitle(conversationId, this);
        });
    }
    /**
     * Call an MCP tool by name with comprehensive logging
     * Automatically routes to the correct MCP server
     * @param toolName The name of the tool to call
     * @param args The arguments to pass to the tool
     * @param context Optional logging context (conversationId, generationId, messageId)
     * @returns The tool execution result
     */
    callMcpTool(toolName, args, context) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const startTime = Date.now();
            // Log tool call start
            yield this.logger.log({
                level: 'info',
                category: 'mcp',
                message: `📡 MCP Tool Call: ${toolName}`,
                conversationId: context === null || context === void 0 ? void 0 : context.conversationId,
                generationId: context === null || context === void 0 ? void 0 : context.generationId,
                metadata: {
                    toolName,
                    args: this.sanitizeArgsForLogging(args),
                    protocol: 'MCP/JSON-RPC 2.0'
                }
            });
            try {
                const result = yield this.mcpRegistry.callTool(toolName, args, {
                    conversationId: context === null || context === void 0 ? void 0 : context.conversationId,
                    generationId: context === null || context === void 0 ? void 0 : context.generationId,
                    messageId: context === null || context === void 0 ? void 0 : context.messageId,
                    credentials: context === null || context === void 0 ? void 0 : context.credentials,
                });
                const duration = Date.now() - startTime;
                // Log success
                yield this.logger.log({
                    level: result.isError ? 'warn' : 'success',
                    category: 'mcp',
                    message: result.isError
                        ? `⚠️ MCP Tool Error: ${toolName} (${duration}ms)`
                        : `✓ MCP Tool Complete: ${toolName} (${duration}ms)`,
                    conversationId: context === null || context === void 0 ? void 0 : context.conversationId,
                    generationId: context === null || context === void 0 ? void 0 : context.generationId,
                    metadata: {
                        toolName,
                        duration,
                        isError: result.isError || false,
                        resultLength: ((_c = (_b = (_a = result.content) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.text) === null || _c === void 0 ? void 0 : _c.length) || 0,
                        protocol: 'MCP/JSON-RPC 2.0'
                    }
                });
                return result;
            }
            catch (error) {
                const duration = Date.now() - startTime;
                const errorMessage = error instanceof Error ? error.message : String(error);
                // Log error
                yield this.logger.log({
                    level: 'error',
                    category: 'mcp',
                    message: `✗ MCP Tool Failed: ${toolName} (${duration}ms)`,
                    conversationId: context === null || context === void 0 ? void 0 : context.conversationId,
                    generationId: context === null || context === void 0 ? void 0 : context.generationId,
                    metadata: {
                        toolName,
                        duration,
                        error: errorMessage,
                        protocol: 'MCP/JSON-RPC 2.0'
                    }
                });
                throw error;
            }
        });
    }
    /**
     * Sanitize arguments for logging (remove sensitive data, truncate long values)
     */
    sanitizeArgsForLogging(args) {
        const sanitized = {};
        for (const [key, value] of Object.entries(args)) {
            if (typeof value === 'string') {
                // Truncate long strings
                sanitized[key] = value.length > 200 ? value.substring(0, 200) + '...' : value;
            }
            else {
                sanitized[key] = value;
            }
        }
        return sanitized;
    }
    /**
     * Get all available MCP tools
     * @returns Array of available tools with their server info
     */
    getMcpTools() {
        return this.mcpRegistry.getAllTools();
    }
}
exports.Red = Red;
