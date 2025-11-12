# Red AI Library

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

> A powerful, graph-based AI agent library built on LangChain and LangGraph with MCP (Model Context Protocol) integration, providing intelligent routing, persistent memory, and unified streaming/non-streaming interfaces.

## 🚀 Features

- **Graph-Based Architecture**: Built on LangGraph for flexible, composable AI workflows
- **MCP Integration**: Model Context Protocol servers for modular tool management (context, RAG, web, system commands)
- **Intelligent Routing**: Automatic routing based on query analysis (chat, web search, URL scraping, system commands)
- **Web Search & Scraping**: Built-in tools via MCP for real-time web search and content extraction
- **Unified Streaming**: Seamless streaming and non-streaming modes with the same API
- **Stream Reconnection**: Redis-backed message queue with pub/sub for reliable mobile streaming
- **Network Resilience**: Automatic retry with exponential backoff for LLM calls and streaming
- **Tool Execution Tracking**: Automatic collection and persistence of tool usage data
- **Persistent Memory**: MongoDB for long-term message storage, Redis for hot state and summaries
- **Vector RAG Support**: Qdrant integration for semantic search and document retrieval
- **Comprehensive Logging**: MongoDB-persisted logs with categories, levels, and generation tracking
- **Thinking Extraction**: Capture and store reasoning from DeepSeek-R1 and similar models
- **Token Tracking**: Complete access to token usage and performance metrics
- **Type-Safe**: Full TypeScript support with type guards
- **Extensible**: Easy to add custom nodes, graphs, and MCP servers

## 📦 Installation

```bash
npm install @redbtn/ai
```

## 🏁 Quick Start

### Prerequisites
Ensure these services are running:
```bash
# Redis
redis-server

# MongoDB
mongod

# Qdrant (for RAG)
docker run -p 6333:6333 qdrant/qdrant

# Ollama (for LLM)
ollama serve
```

### Installation
```bash
npm install @redbtn/ai
```

### Basic Usage

```typescript
import { Red, RedConfig } from '@redbtn/ai';

// Configure your Red instance
const config: RedConfig = {
  redisUrl: "redis://localhost:6379",
  vectorDbUrl: "http://localhost:6333",
  databaseUrl: "mongodb://localhost:27017/redbtn_ai",
  chatLlmUrl: "http://localhost:11434",  // Primary chat model (Ollama)
  workLlmUrl: "http://localhost:11434"   // Worker model for routing/tools
};

// Initialize and load
const red = new Red(config);
await red.load("my-node");

// Start MCP servers (required for tools)
// In separate terminal: npm run mcp:start

// Get a response (non-streaming)
const response = await red.respond(
  { message: 'Hello!' },
  { conversationId: 'conv_123' }
);

console.log(response.content);         // "Hello! How can I help you?"
console.log(response.usage_metadata);  // { input_tokens: 10, output_tokens: 5, ... }

// Or stream the response
const stream = await red.respond(
  { message: 'Search for TypeScript tutorials' },
  { stream: true, conversationId: 'conv_456' }
);

for await (const chunk of stream) {
  if (typeof chunk === 'object' && chunk._metadata) {
    // First chunk with conversation ID
    console.log('Conversation:', chunk.conversationId);
  } else if (typeof chunk === 'string') {
    process.stdout.write(chunk);  // Real-time text
  } else {
    // Final AIMessage with metadata
    console.log('\nTokens:', chunk.usage_metadata);
  }
}

// Graceful shutdown
await red.shutdown();
```

### Testing Web Search
```typescript
// This will automatically trigger web search via MCP
const response = await red.respond(
  { message: 'What is the weather in San Francisco today?' }
);

console.log(response.content);
// The router detects this needs web search and calls the web_search MCP tool
```

## 📚 Core Concepts

The Red AI library provides a unified interface for both streaming and non-streaming LLM interactions through a graph-based architecture.

## 📖 API Reference

### Configuration

```typescript
interface RedConfig {
  redisUrl: string;        // Redis connection for global state & hot memory
  vectorDbUrl: string;     // Vector database URL for RAG embeddings
  databaseUrl: string;     // MongoDB URL for long-term message persistence
  chatLlmUrl: string;      // Chat LLM endpoint (primary model for user interactions)
  workLlmUrl: string;      // Worker LLM endpoint (for routing and tool execution)
  llmEndpoints?: {         // Optional: named LLM endpoints
    [agentName: string]: string;
  };
}
```

### Initialization

```typescript
const red = new Red(config);
await red.load(nodeId?: string);  // Optional node ID for distributed systems

// Access subsystems:
red.memory         // MemoryManager - conversation history & summaries
red.messageQueue   // MessageQueue - streaming state & reconnection
red.logger         // PersistentLogger - MongoDB-persisted logging system
red.mcpRegistry    // McpRegistry - MCP tool server registry
red.chatModel      // ChatOllama - primary chat model
red.workerModel    // ChatOllama - worker model for routing/tools
red.geminiModel    // ChatGoogleGenerativeAI - optional Gemini model
red.openAIModel    // ChatOpenAI - optional OpenAI model
```

### Response Options

```typescript
interface InvokeOptions {
  source?: {
    device?: 'phone' | 'speaker' | 'web';
    application?: 'redHome' | 'redChat' | 'redAssistant';
  };
  stream?: boolean;          // Enable streaming mode
  conversationId?: string;   // Optional - auto-generated if omitted
  generationId?: string;     // Optional - auto-generated if omitted (for logging)
  messageId?: string;        // Optional - for Redis pub/sub streaming reconnection
}
```

**Important Notes:**
- `conversationId`: If not provided, a new conversation is created with ID format `conv_{timestamp}_{random}`
- `generationId`: Auto-generated for logging/tracking purposes, format `gen_{timestamp}_{random}`
- `messageId`: Used for streaming reconnection via Redis pub/sub, passed from API layer
- All IDs are automatically generated if omitted for convenience

### MessageQueue & Stream Reconnection

The `MessageQueue` class provides Redis-backed streaming with pub/sub for reliable reconnection:

```typescript
// Start tracking a message generation
await red.messageQueue.startGeneration(conversationId, messageId);

// Append content as it streams in
await red.messageQueue.appendContent(messageId, chunk);

// Publish status updates
await red.messageQueue.publishStatus(messageId, 'processing', 'Analyzing query');

// Publish tool events for tracking
await red.messageQueue.publishToolEvent(messageId, {
  type: 'tool_start',
  toolId: 'tool_123',
  toolType: 'web_search',
  toolName: 'Web Search',
  timestamp: Date.now()
});

// Complete the generation
await red.messageQueue.completeGeneration(messageId, metadata);

// Subscribe to a message stream (yields existing + new content)
for await (const event of red.messageQueue.subscribeToMessage(messageId)) {
  if (event.type === 'init') {
    console.log('Existing content:', event.existingContent);
  } else if (event.type === 'chunk') {
    console.log(event.content);
  } else if (event.type === 'tool_event') {
    console.log('Tool event:', event.event.type, event.event.toolName);
  } else if (event.type === 'status') {
    console.log('Status:', event.action, event.description);
  } else if (event.type === 'complete') {
    console.log('Done:', event.metadata);
  }
}
```

**Key Features:**
- **Redis Pub/Sub**: Real-time chunk delivery to multiple subscribers
- **Reconnection**: Clients can disconnect and reconnect to ongoing streams
- **Accumulated Content**: New subscribers receive all previous chunks immediately
- **Tool Event Tracking**: Stores tool execution events for reconnection support
- **Status Broadcasting**: Real-time status updates (routing, searching, thinking, etc.)
- **1-hour TTL**: Transient state cleanup after completion

### Logging System

Red AI includes a comprehensive MongoDB-persisted logging system:

```typescript
// Log with context
await red.logger.log({
  level: 'info' | 'success' | 'warn' | 'error' | 'debug' | 'trace',
  category: 'system' | 'router' | 'mcp' | 'memory' | 'responder' | 'tool',
  message: 'Operation completed',
  conversationId: 'conv_123',
  generationId: 'gen_456',
  nodeId: 'node_abc',
  metadata: { key: 'value' }
});

// Track generation lifecycle
const genId = await red.logger.startGeneration(conversationId);
await red.logger.completeGeneration(genId, {
  response: 'Hello!',
  thinking: 'I analyzed the query...',
  route: 'chat',
  toolsUsed: [],
  model: 'llama3.2',
  tokens: { input: 10, output: 5, total: 15 }
});
await red.logger.failGeneration(genId, 'Error message');

// Log thinking/reasoning (stored separately from messages)
await red.logger.logThought({
  content: 'I should search the web for this',
  source: 'router' | 'chat' | 'toolPicker',
  conversationId: 'conv_123',
  generationId: 'gen_456',
  messageId: 'msg_789'
});

// Subscribe to real-time logs for a conversation
for await (const log of red.logger.subscribeToConversation('conv_123')) {
  console.log(`[${log.level}] ${log.message}`);
}

// Query logs from MongoDB
const logs = await red.logger.getLogsForConversation('conv_123', {
  limit: 100,
  level: 'error',
  category: 'tool'
});
```

**Features:**
- **MongoDB Persistence**: 6-month TTL with automatic cleanup
- **Colored Console Output**: ANSI colors for different log levels
- **Generation Tracking**: Complete lifecycle from start to completion/failure
- **Thinking Storage**: Separate collection for DeepSeek-R1 reasoning chains
- **Real-time Streaming**: Subscribe to logs via Redis pub/sub
- **Structured Metadata**: Rich context with conversationId, generationId, nodeId
- **Indexed Queries**: Fast lookups by conversation, generation, category, level

---

## 🎯 Usage Patterns

### Non-Streaming Mode

When `options.stream` is `false` or omitted, `respond()` returns the complete AIMessage object:

```typescript
const response = await red.respond(
  { message: 'Hello' },
  { source: { application: 'redChat' } }
);

// response is the full AIMessage object
console.log(response.content);              // "Hello! How can I help?"
console.log(response.usage_metadata);       // { input_tokens: 10, output_tokens: 5, ... }
console.log(response.response_metadata);    // { model: "Red", duration: ..., ... }
```

**Return Type**: `AIMessage` - The complete response object from LangChain/Ollama

**Properties Available**:
- `content` - The text response
- `usage_metadata` - Token usage information
  - `input_tokens` - Number of input tokens
  - `output_tokens` - Number of output tokens  
  - `total_tokens` - Total tokens used
- `response_metadata` - Model and performance metadata
  - `model` - Model name
  - `created_at` - Timestamp
  - `total_duration` - Total time in nanoseconds
  - `eval_duration` - Generation time in nanoseconds
  - `prompt_eval_duration` - Prompt processing time
- `additional_kwargs` - Any extra data from the model
- `tool_calls` - Tool/function calls (if any)

---

### Streaming Mode

When `options.stream` is `true`, `respond()` returns an async generator that:
1. **Yields string chunks** as they arrive from the LLM
2. **Yields the final AIMessage** with complete metadata when streaming completes

```typescript
const stream = await red.respond(
  { message: 'Tell me a story' },
  { source: { application: 'redChat' }, stream: true }
);

let conversationId: string | undefined;

for await (const chunk of stream) {
  // First chunk is metadata with conversationId
  if (typeof chunk === 'object' && chunk._metadata) {
    conversationId = chunk.conversationId;
    console.log('Conversation ID:', conversationId);
  } else if (typeof chunk === 'string') {
    // Text chunk - display in real-time
    process.stdout.write(chunk);
  } else {
    // Final AIMessage with complete token data
    console.log('\nTotal tokens:', chunk.usage_metadata?.total_tokens);
    console.log('Generation speed:', 
      chunk.usage_metadata?.output_tokens / 
      (chunk.response_metadata?.eval_duration / 1_000_000_000),
      'tokens/second'
    );
  }
}
```

**Return Type**: `AsyncGenerator<string | AIMessage, void, unknown>`

**Yields**:
1. Multiple `string` chunks - Real-time text content
2. One final `AIMessage` - Complete response with all metadata

---

## 🎨 Advanced Usage

### Autonomous Thinking Loop

Red AI features an **autonomous thinking mode** that enables truly self-directed AI agents. When activated, each Red instance can continuously operate, research, and improve its knowledge base with minimal human intervention.

**Core Concept:**
- Each node instance runs an independent thinking loop
- The agent prompts itself to work on projects, conduct research, and expand knowledge
- User provides high-level direction and goals
- The agent autonomously decides what to research, what tools to use, and how to improve
- All learning is persisted across the three-tier memory system (Redis, Vector DB, MongoDB)

**Memory Evolution:**
- **Redis**: Captures current thoughts, active context, and working memory
- **Vector DB**: Stores semantic knowledge for fast retrieval and pattern recognition
- **MongoDB**: Archives complete history, reasoning chains, and long-term knowledge

**Usage:**

```typescript
// Initialize and load Red instance
const red = new Red(config);
await red.load("autonomous-researcher");

// Start autonomous thinking loop
await red.think();

// Agent now runs continuously, self-prompting with:
// - Research queries based on prior knowledge gaps
// - Web searches to gather new information
// - Document analysis and knowledge extraction
// - Self-evaluation and knowledge consolidation
// - Tool usage (search, scrape, commands) as needed

// The loop continues until explicitly stopped
// Stop when needed (gracefully completes current cycle)
red.stopThinking();
```

**Autonomous Capabilities:**
- **Self-Directed Research**: Agent identifies knowledge gaps and researches independently
- **Tool Selection**: Automatically chooses appropriate tools (web search, scraping, commands)
- **Knowledge Building**: Continuously expands understanding through iterative research cycles
- **Context Retention**: Builds on previous cycles using persistent memory
- **Goal Pursuit**: Works toward user-defined objectives autonomously
- **Learning Loops**: Each cycle improves the knowledge base for future cycles

**Example Autonomous Session:**
```typescript
// User provides initial direction
const red = new Red(config);
await red.load("research-assistant");

// Seed the agent with a goal (via conversation or direct state)
await red.respond({ 
  message: "Research and compile information about quantum computing applications in cryptography" 
});

// Start autonomous mode
await red.think();

// Agent will now:
// 1. Break down the research topic into sub-questions
// 2. Search the web for relevant papers and articles
// 3. Scrape key resources for detailed information
// 4. Store findings in vector DB for semantic retrieval
// 5. Generate summaries and connect concepts
// 6. Identify new questions and repeat
// 7. Build comprehensive knowledge base over time

// Hours or days later, stop the loop
red.stopThinking();

// All research is preserved in memory for future queries
const summary = await red.respond({ 
  message: "Summarize your findings on quantum cryptography" 
});
```

**Implementation Details:**
- Runs in a continuous `do-while` loop checking `isThinking` flag
- 2-second delay between cycles to prevent runaway resource usage
- Each cycle invokes the 'cognitionGraph' with autonomous cycle type
- Graceful shutdown ensures current cycle completes before stopping
- All progress persisted to MongoDB for resumption after restarts

**Future Enhancements:**
- Multi-agent collaboration (multiple Red instances working together)
- Goal decomposition and task planning
- Self-evaluation and quality metrics
- Knowledge graph construction
- Scheduled autonomous sessions
- Priority-based research queuing

---

### Type Guard Pattern

To handle both modes elegantly:

```typescript
const response = await red.respond(query, options);

// Check if it's an AIMessage (non-streaming) vs AsyncGenerator (streaming)
if (Symbol.asyncIterator in response) {
  // Streaming mode
  for await (const chunk of response) {
    if (typeof chunk === 'string') {
      // Handle text chunk
    } else {
      // Handle final metadata
    }
  }
} else {
  // Non-streaming mode
  console.log(response.content);
  console.log(response.usage_metadata);
}
```

### Performance Metrics

## Environment Variables

Red AI uses environment variables for configuration. Create a `.env` file at the project root:

```bash
# Redis Configuration
REDIS_URL=redis://localhost:6379

# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/redbtn_ai

# Vector Database (Qdrant)
VECTOR_DB_URL=http://localhost:6333

# LLM Endpoints (Ollama)
CHAT_LLM_URL=http://localhost:11434  # Primary chat model
WORK_LLM_URL=http://localhost:11434  # Worker model for routing/tools
OLLAMA_MODEL=llama3.2                # Default model name

# Web Search (Google Custom Search)
GOOGLE_API_KEY=your_google_api_key
GOOGLE_SEARCH_ENGINE_ID=your_search_engine_id

# Optional: OpenAI/Gemini
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...

# Server Configuration (for examples)
PORT=3000
BEARER_TOKEN=red_ai_sk_...

# System Prompt Override (optional)
SYSTEM_PROMPT="You are Red, an AI assistant..."
```

**Important Environment Variables:**

- `REDIS_URL`: Required for message queue and hot memory cache
- `MONGODB_URI`: Required for persistent storage (messages, logs, generations)
- `VECTOR_DB_URL`: Required for RAG operations (Qdrant vector database)
- `CHAT_LLM_URL`: Primary chat model endpoint
- `WORK_LLM_URL`: Worker model for routing and tool execution
- `GOOGLE_API_KEY` + `GOOGLE_SEARCH_ENGINE_ID`: Required for web search functionality

The library automatically loads `.env` using `dotenv/config` at startup. Restart after changes.

Calculate generation speed and analyze performance:

```typescript
const response = await red.respond(query, options);

const tokensPerSecond = 
  response.usage_metadata.output_tokens / 
  (response.response_metadata.eval_duration / 1_000_000_000);

console.log(`Speed: ${tokensPerSecond.toFixed(2)} tokens/second`);
console.log(`Total duration: ${response.response_metadata.total_duration}ns`);
```

---

## 🏗️ Architecture

### Multi-Layer Memory System
- **Redis (Hot Cache)**: 
  - Last 100 messages per conversation (configurable limit)
  - Active conversation state and summaries
  - Message generation tracking (streaming state)
  - Message ID index for duplicate detection (1-hour TTL)
- **MongoDB (Persistent Storage)**: 
  - Complete message history with tool execution data
  - Logs with 6-month TTL and automatic cleanup
  - Generation tracking (lifecycle, tokens, performance)
  - Thinking/reasoning chains (stored separately)
  - Conversation metadata (title, message count, tokens)
- **Vector Database (Qdrant)**: 
  - Semantic search for RAG operations
  - Document chunking and embedding
  - Collection management per conversation
- **Executive Summaries**: 
  - Auto-generated after 3+ messages
  - Trailing summaries for trimmed context
  - Token-aware context window management
- **Context MCP Server**: Centralized conversation management with 7 tools

### MCP (Model Context Protocol) Architecture
Red AI uses MCP for modular, extensible tool management:

- **JSON-RPC 2.0 Protocol**: Standardized communication over Redis pub/sub
- **Separate Processes**: Each MCP server runs independently for resilience
- **Dynamic Tool Discovery**: Tools are discovered and registered at runtime
- **Event Publishing**: Real-time tool execution events via Redis
- **Metadata Support**: conversationId, generationId, messageId passed to all tools

**Available MCP Servers:**

1. **Context Server** (7 tools):
   - `get_messages` - Retrieve conversation messages with tool execution data
   - `get_context_history` - Get formatted context for LLM (manages token limits)
   - `get_summary` - Retrieve executive/trailing conversation summaries
   - `store_message` - Save messages to MongoDB with tool executions
   - `get_conversation_metadata` - Get metadata (message count, tokens, etc.)
   - `get_token_count` - Calculate token usage for text
   - `list_conversations` - List all conversations with pagination

2. **Web Server** (2 tools):
   - `web_search` - Google Custom Search API integration
   - `scrape_url` - URL content extraction with custom parser

3. **System Server** (1 tool):
   - `execute_command` - Run whitelisted system commands (git, ls, etc.)

4. **RAG Server** (2 tools):
   - `add_to_vector_store` - Add documents to Qdrant vector database
   - `retrieve_from_vector_store` - Semantic search with configurable results

**Starting MCP Servers:**
```bash
npm run mcp:start  # Starts all MCP servers (context, web, system, rag)
# Servers run in foreground - press Ctrl+C to stop
# Or run in background: npm run mcp:start &
```

**Available Scripts:**
```bash
npm run build              # Compile TypeScript to dist/
npm run pack               # Build and create .tgz package
npm run mcp:start          # Start MCP servers
npm run dev:server         # Start REST API server in dev mode
npm run start:server       # Start REST API server
npm run db:fix-messageids  # Fix null messageId values in MongoDB
npm run redis:cleanup-dupes # Remove duplicate messages from Redis
```

**Using MCP Tools:**
```typescript
// Call any MCP tool through the registry
const result = await red.callMcpTool(
  'store_message',
  {
    conversationId: 'conv_123',
    role: 'user',
    content: 'Hello!',
    messageId: 'msg_456',
    toolExecutions: []  // Include tool execution data if available
  },
  {
    conversationId: 'conv_123',
    generationId: 'gen_789',
    messageId: 'msg_456'
  }
);

// Result structure
if (result.isError) {
  console.error('Tool error:', result.content[0].text);
} else {
  const data = JSON.parse(result.content[0].text);
  console.log('Success:', data);
}
```

### Stream Reconnection Architecture
- **Decoupled Generation**: LLM generation runs independently of HTTP transport
- **Redis Pub/Sub**: Real-time event publishing to `message:stream:{messageId}` channels
- **Accumulated Content**: New subscribers instantly receive all previous chunks
- **Tool Event Persistence**: Tool execution events stored in generation state for reconnection
- **Status Broadcasting**: Real-time status updates (initializing, routing, searching, thinking, streaming)
- **MessageQueue API**: `subscribeToMessage()` async generator yielding init/chunk/status/tool_event/complete
- **1-hour TTL**: Transient state cleanup after completion
- **Mobile-Friendly**: Survives app switching and network interruptions

### Unified Streaming
- **Consistent patterns**: Both modes go through the same graph execution
- **Token-level streaming**: Real-time chunks during generation
- **Complete metadata**: Full token counts and performance data at the end
- **Tool Execution Tracking**: Tool events automatically converted to structured execution data
- **Mobile-friendly**: Streams survive app switching and network interruptions

### Tool Execution Storage
Red AI automatically tracks and persists tool execution data:

```typescript
// Tool executions are automatically collected from Redis state
// and stored with assistant messages in MongoDB

// Structure stored in database:
interface StoredToolExecution {
  toolId: string;           // Unique ID for this execution
  toolType: string;         // 'web_search', 'scrape_url', 'command', etc.
  toolName: string;         // Human-readable name
  status: 'running' | 'completed' | 'error';
  startTime: Date;          // When tool started
  endTime?: Date;           // When tool finished
  duration?: number;        // Execution time in milliseconds
  steps: Array<{            // Progress steps
    step: string;
    timestamp: Date;
    progress?: number;
    data?: any;
  }>;
  currentStep?: string;     // Current/last step
  progress?: number;        // 0-100 progress indicator
  result?: any;             // Tool result data
  error?: string;           // Error message if failed
  metadata?: Record<string, any>;  // Additional context
}

// Automatically retrieved when loading conversations
const messages = await red.memory.getMessages('conv_123');
messages.forEach(msg => {
  if (msg.toolExecutions && msg.toolExecutions.length > 0) {
    console.log(`Message ${msg.id} used ${msg.toolExecutions.length} tools`);
    msg.toolExecutions.forEach(tool => {
      console.log(`  - ${tool.toolName}: ${tool.status} (${tool.duration}ms)`);
    });
  }
});
```

**Key Features:**
- **Automatic Collection**: Tool events from Redis are converted to structured executions
- **Persistent Storage**: Stored in MongoDB with each assistant message
- **Full History**: Start/end times, duration, progress steps, results
- **Error Tracking**: Captures failures with error messages
- **Metadata Support**: Custom data for each tool and step

### Graph Structure

```
┌─────────┐
│  Start  │
└────┬────┘
     │
     ▼
┌──────────┐
│  Router  │  ──→ Analyzes query, decides: CHAT, WEB_SEARCH, SCRAPE_URL, or SYSTEM_COMMAND
└────┬─────┘      (Uses worker model with structured output)
     │
     ├─────→ CHAT ──────────────────┐
     │      (skip to responder)     │
     │                               │
     ├─────→ WEB_SEARCH ─────────────┤
     │      (search node via MCP)   │
     │                               │
     ├─────→ SCRAPE_URL ─────────────┤
     │      (scrape node via MCP)   │
     │                               │
     └─────→ SYSTEM_COMMAND ─────────┤
            (command node via MCP)  │
                                    ▼
                              ┌───────────┐
                              │ Responder │  ──→ Generates response with context + tool results
                              └─────┬─────┘      (Uses chat model, publishes thinking/chunks)
                                    │
                                    ▼
                              ┌─────────┐
                              │   End   │  ──→ Stores message, triggers background tasks
                              └─────────┘      (Title gen, summarization, exec summary)
```

**Flow:**
1. **Router Node**: 
   - Retrieves conversation history via Context MCP
   - Uses worker model to classify query intent with structured output
   - Publishes thinking/reasoning to Redis for storage
   - Returns route decision: CHAT, WEB_SEARCH, SCRAPE_URL, or SYSTEM_COMMAND

2. **Tool Nodes** (conditional):
   - **Search Node**: Calls `web_search` MCP tool, publishes tool events (start/progress/complete)
   - **Scrape Node**: Calls `scrape_url` MCP tool, extracts clean content
   - **Command Node**: Calls `execute_command` MCP tool with security checks
   - All tool events stored in Redis for reconnection and persistence

3. **Responder Node**:
   - Retrieves conversation context via Context MCP
   - Includes tool results if available
   - Uses chat model to generate response
   - Publishes thinking (extracted from DeepSeek-R1 `<think>` tags)
   - Streams chunks via Redis pub/sub
   - Stores final message with tool execution data

4. **Background Tasks** (non-blocking):
   - Title generation after 2+ messages
   - Trailing summary when context exceeds token limit
   - Executive summary after 3+ messages
   - Heartbeat registration for distributed nodes

**MCP Integration:**
- **Context Server (7 tools)**: History, summaries, message storage, metadata, token counting
- **Web Server (2 tools)**: Google Custom Search API, URL content scraping
- **System Server (1 tool)**: Whitelisted command execution (git, ls, etc.)
- **RAG Server (2 tools)**: Qdrant vector store operations for semantic search

---

## 📋 Examples

The `examples/` directory contains self-contained examples with their own dependencies:

### 🤖 [Discord Bot](examples/discord)
Full-featured Discord bot that responds when mentioned in channels.
- Tag-based activation
- Per-channel conversation management  
- Multi-user context formatting
- Streaming responses with typing indicators

```bash
cd examples/discord && npm install && npm start
```

### 🌐 [REST API Server](examples/rest-server)
OpenAI-compatible API server for Red AI.
- Works with OpenWebUI, Cursor, Continue, etc.
- Streaming and non-streaming modes
- Bearer token authentication
- Includes TypeScript client example

```bash
cd examples/rest-server && npm install && npm start
```

See [examples/README.md](examples/README.md) for complete documentation.

---

## � Recent Improvements

### Tool Execution Persistence (Latest)
- **Automatic Storage**: Tool executions are now automatically collected from Redis events and stored with messages
- **Complete History**: Full execution data including start/end times, duration, progress steps, and results
- **Reconnection Support**: Tool events persist in Redis state for stream reconnection
- **Database Schema**: `StoredToolExecution` interface in MongoDB with all execution metadata

### Network Resilience
- **Automatic Retry**: LLM calls retry up to 3 times on network errors with exponential backoff
- **Streaming Retry**: Responder streaming loop continues on transient failures
- **Network Detection**: Distinguishes network errors from model errors for smart retry behavior

### Message Deduplication
- **Redis ID Index**: Messages indexed by ID with 1-hour TTL to prevent duplicates
- **Atomic Operations**: Race-condition safe message storage across parallel MCP servers
- **MongoDB Deduplication**: Unique messageId index with duplicate key error handling

### Thinking Extraction (DeepSeek-R1 Support)
- **Automatic Detection**: Extracts `<think>...</think>` tags from model responses
- **Separate Storage**: Thinking stored in dedicated MongoDB collection, not in message content
- **Source Tracking**: Captures thinking from router, responder, and tool picker nodes

---

## �🚀 Deployment Options

Red AI supports **two deployment strategies** to give you maximum flexibility:

### 1. Standalone Express Server (Traditional)
- ✅ Fast cold starts (~500ms)
- ✅ Full tiktoken support
- ✅ OpenWebUI compatible
- ✅ Can run in specialized modes
- ❌ Requires always-on server

### 2. Next.js Serverless (Modern)
- ✅ Deploy to Vercel/AWS Lambda/Cloudflare
- ✅ Auto-scaling (0→∞)
- ✅ Built-in custom UI
- ✅ Global CDN
- ❌ Cold starts on low traffic

Both options share the same core `src/` library for consistent behavior.

**See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed deployment guides.**

---

## 🔄 Migration Guide

If you had code using the old API:

### Old (Redundant)
```typescript
const result = await red.respond(query, options);
console.log(result.response);  // String
console.log(result.metadata);  // AIMessage
```

### New (Clean)
```typescript
const response = await red.respond(query, options);
console.log(response.content);         // String
console.log(response.usage_metadata);  // Token info
// All properties directly on the response object
```

---

## 📊 Response Structure

### AIMessage Properties

When you receive a response, it includes:

| Property | Type | Description |
|----------|------|-------------|
| `content` | `string` | The generated text response |
| `usage_metadata` | `object` | Token usage information |
| `usage_metadata.input_tokens` | `number` | Number of input tokens |
| `usage_metadata.output_tokens` | `number` | Number of output tokens |
| `usage_metadata.total_tokens` | `number` | Total tokens used |
| `response_metadata` | `object` | Model and performance data |
| `response_metadata.model` | `string` | Model name used |
| `response_metadata.total_duration` | `number` | Total time in nanoseconds |
| `response_metadata.eval_duration` | `number` | Generation time in nanoseconds |
| `response_metadata.prompt_eval_duration` | `number` | Prompt processing time |
| `additional_kwargs` | `object` | Extra data from the model |
| `tool_calls` | `array` | Tool/function calls (if any) |

---

## 🛠️ Development

### Prerequisites

- Node.js 18+
- TypeScript 5.x
- Redis (for state management)
- Ollama or compatible LLM endpoint

### Setup

```bash
# Clone the repository
git clone https://github.com/redbtn-io/ai.git
cd ai

# Install dependencies
npm install

# Build
npm run build

# Run example
npx tsx examples/token-access.ts
```

### Project Structure

```
ai/
├── src/
│   ├── index.ts           # Main Red class and exports
│   ├── functions/
│   │   ├── respond.ts     # Core response generation with streaming
│   │   └── background/    # Background tasks (summarization, titles, heartbeat)
│   ├── lib/
│   │   ├── models.ts      # LLM model configurations
│   │   ├── graphs/
│   │   │   └── red.ts     # Main StateGraph definition
│   │   ├── nodes/
│   │   │   ├── router.ts  # Intelligent routing with structured output
│   │   │   ├── responder.ts  # Final response generation
│   │   │   ├── search/    # Web search implementation
│   │   │   ├── scrape/    # URL scraping implementation
│   │   │   ├── command/   # System command execution
│   │   │   └── rag/       # Vector store operations
│   │   ├── mcp/
│   │   │   ├── client.ts  # MCP JSON-RPC client
│   │   │   ├── server.ts  # MCP server base class
│   │   │   ├── registry.ts # MCP server registry
│   │   │   ├── event-publisher.ts # Tool event publishing
│   │   │   └── servers/   # MCP server implementations
│   │   │       ├── context.ts  # Conversation context & history (7 tools)
│   │   │       ├── rag.ts      # Vector database operations (2 tools)
│   │   │       ├── web.ts      # Web search & scraping (2 tools)
│   │   │       ├── system.ts   # System command execution (1 tool)
│   │   │       ├── web-search.ts    # Standalone web search server
│   │   │       ├── url-scraper.ts   # Standalone URL scraper server
│   │   │       └── system-command.ts # Standalone command server
│   │   ├── memory/
│   │   │   ├── memory.ts  # MemoryManager (Redis + MongoDB)
│   │   │   ├── queue.ts   # MessageQueue for streaming & reconnection
│   │   │   ├── database.ts # MongoDB operations & tool execution storage
│   │   │   └── vectors.ts # Vector store manager (Qdrant)
│   │   ├── logs/
│   │   │   ├── logger.ts  # Structured logging with colors
│   │   │   ├── persistent-logger.ts # MongoDB-persisted logs
│   │   │   ├── types.ts   # Log type definitions
│   │   │   └── colors.ts  # Console color utilities
│   │   ├── events/
│   │   │   ├── integrated-publisher.ts # Tool event publishing bridge
│   │   │   └── tool-events.ts # Tool event type definitions
│   │   └── utils/
│   │       ├── thinking.ts # Extract/log thinking from DeepSeek-R1
│   │       ├── json-extractor.ts # Robust JSON parsing
│   │       ├── tokenizer.ts # Token counting utilities
│   │       └── retry.ts    # Network retry logic for LLM calls
│   └── mcp-servers.ts     # MCP servers launcher
├── examples/
│   ├── discord/           # Discord bot implementation
│   │   ├── discord-bot.ts # Main bot with per-channel conversations
│   │   └── package.json   # Discord-specific dependencies
│   └── rest-server/       # OpenAI-compatible REST API
│       ├── server.ts      # Express server with streaming support
│       ├── client.ts      # Example TypeScript client
│       └── package.json   # Server-specific dependencies
└── README.md              # This file
```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

ISC License - see the [LICENSE](LICENSE) file for details.

---

## � Troubleshooting

### MCP Tool Calls Failing
```
⚠️ MCP server registration failed
Tool calls will fail. Make sure MCP servers are running: npm run mcp:start
```

**Solution**: Start MCP servers before initializing Red:
```bash
npm run mcp:start &
# Then run your application
```

### Duplicate Messages in Redis
If you see duplicate messages accumulating:
```bash
npm run redis:cleanup-dupes
```

### Missing Tool Executions After Reload
If tool executions don't appear after page refresh:
1. Check MongoDB for `toolExecutions` array in messages collection
2. Verify Redis message queue has `toolEvents` in generation state
3. Ensure frontend POST to `/tool-executions` endpoint succeeds

### MongoDB Authentication Errors
```
Command find requires authentication
```

**Solution**: Update MongoDB URI with credentials:
```bash
MONGODB_URI=mongodb://username:password@localhost:27017/redbtn_ai?authSource=admin
```

### Network Timeout Errors
If LLM calls timeout frequently, the retry logic will handle transient failures automatically. For persistent issues:
1. Check LLM endpoint accessibility: `curl http://localhost:11434`
2. Increase timeout in model config (default: 10000ms)
3. Verify network connectivity between services

### Redis Connection Issues
```
Error: Redis connection failed
```

**Solution**:
1. Verify Redis is running: `redis-cli ping` should return `PONG`
2. Check Redis URL in environment: `REDIS_URL=redis://localhost:6379`
3. Ensure Redis accepts connections: Check `bind` setting in `redis.conf`

---

## �🔗 Links

- **GitHub**: [redbtn-io/ai](https://github.com/redbtn-io/ai)
- **LangChain**: [https://js.langchain.com](https://js.langchain.com)
- **LangGraph**: [https://langchain-ai.github.io/langgraphjs](https://langchain-ai.github.io/langgraphjs)
- **Qdrant**: [https://qdrant.tech](https://qdrant.tech)
- **Model Context Protocol**: [https://modelcontextprotocol.io](https://modelcontextprotocol.io)

---

## 📞 Support

For questions and support, please open an issue on GitHub.

---

**Built with ❤️ by the Red Button team**
