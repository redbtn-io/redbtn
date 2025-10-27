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
- **Persistent Memory**: MongoDB for long-term message storage, Redis for hot state and summaries
- **Comprehensive Logging**: MongoDB-persisted logs with categories, levels, and generation tracking
- **Token Tracking**: Complete access to token usage and performance metrics
- **Type-Safe**: Full TypeScript support with type guards
- **Extensible**: Easy to add custom nodes, graphs, and MCP servers

## 📦 Installation

```bash
npm install @redbtn/ai
```

## 🏁 Quick Start

```typescript
import { Red, RedConfig } from '@redbtn/ai';

// Configure your Red instance
const config: RedConfig = {
  redisUrl: "redis://localhost:6379",
  vectorDbUrl: "http://localhost:8200",
  databaseUrl: "mongodb://localhost:27017/red-webapp",
  chatLlmUrl: "http://192.168.1.4:11434",  // Primary chat model (Ollama)
  workLlmUrl: "http://192.168.1.3:11434"   // Worker model for routing/tools
};

// Initialize and load
const red = new Red(config);
await red.load("my-node");

// Get a response (non-streaming)
const response = await red.respond(
  { message: 'Hello!' },
  { conversationId: 'conv_123' }
);

console.log(response.content);         // "Hello! How can I help you?"
console.log(response.usage_metadata);  // { input_tokens: 10, output_tokens: 5, ... }

// Or stream the response
const stream = await red.respond(
  { message: 'Tell me a story' },
  { stream: true, conversationId: 'conv_123' }
);

for await (const chunk of stream) {
  if (typeof chunk === 'string') {
    process.stdout.write(chunk);  // Real-time text
  } else {
    console.log('Tokens:', chunk.usage_metadata);  // Final metadata
  }
}
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

// Complete the generation
await red.messageQueue.completeGeneration(messageId, metadata);

// Subscribe to a message stream (yields existing + new content)
for await (const event of red.messageQueue.subscribeToMessage(messageId)) {
  if (event.type === 'chunk') {
    console.log(event.content);
  } else if (event.type === 'complete') {
    console.log('Done:', event.metadata);
  }
}
```

**Key Features:**
- **Redis Pub/Sub**: Real-time chunk delivery to multiple subscribers
- **Reconnection**: Clients can disconnect and reconnect to ongoing streams
- **Accumulated Content**: New subscribers receive all previous chunks immediately
- **1-hour TTL**: Transient state cleanup after completion

### Logging System

Red AI includes a comprehensive MongoDB-persisted logging system:

```typescript
// Log with context
await red.logger.log({
  level: 'info' | 'success' | 'warn' | 'error',
  category: 'system' | 'router' | 'mcp' | 'memory' | 'responder' | 'tool',
  message: 'Operation completed',
  conversationId: 'conv_123',
  generationId: 'gen_456',
  metadata: { key: 'value' }
});

// Track generation lifecycle
const genId = await red.logger.startGeneration(conversationId);
await red.logger.completeGeneration(genId, {
  response: 'Hello!',
  tokens: { input: 10, output: 5, total: 15 }
});
await red.logger.failGeneration(genId, 'Error message');

// Log thinking/reasoning
await red.logger.logThought({
  content: 'I should search the web for this',
  source: 'router',
  conversationId: 'conv_123',
  generationId: 'gen_456'
});
```

**Features:**
- MongoDB persistence with indexes on conversationId, generationId, category
- Colored console output with log levels
- Generation lifecycle tracking (start, complete, fail)
- Thinking/reasoning capture from models
- Structured metadata support

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

## Environment variables (.env)

This project supports loading environment variables from a `.env` file using `dotenv`. Create a `.env` file at the project root with values such as:

```
REDIS_URL=redis://192.168.1.10:6379
LLM_URL=https://llm.redbtn.io
BEARER_TOKEN=red_ai_sk_...
PORT=3000
```

The server and library load `.env` automatically at startup. Restart the server after changing `.env`.

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
- **Redis (Hot)**: Active conversation state, summaries, generating message tracking
- **MongoDB (Persistent)**: Complete message history, logs, generations - searchable, survives Redis flushes
- **Executive Summaries**: Auto-generated after 3+ messages for quick context retrieval
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
   - `get_messages` - Retrieve conversation messages
   - `get_context_history` - Get formatted context for LLM
   - `get_summary` - Retrieve conversation summary
   - `store_message` - Save messages to MongoDB
   - `get_conversation_metadata` - Get metadata (message count, tokens)
   - `get_token_count` - Calculate token usage
   - `list_conversations` - List all conversations

2. **Web Server** (2 tools):
   - `search_web` - Tavily web search
   - `scrape_url` - URL content extraction

3. **System Server** (1 tool):
   - `execute_command` - Run whitelisted system commands

4. **RAG Server** (2 tools):
   - `add_to_vector_store` - Add documents to vector DB
   - `retrieve_from_vector_store` - Semantic search

**Starting MCP Servers:**
```bash
npm run mcp-servers  # Starts all MCP servers in background
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
    messageId: 'msg_456'
  },
  {
    conversationId: 'conv_123',
    generationId: 'gen_789',
    messageId: 'msg_456'
  }
);
```

### Stream Reconnection Architecture
- **Decoupled Generation**: LLM generation runs independently of HTTP transport
- **Redis Pub/Sub**: Real-time chunk publishing to `message:stream:{messageId}` channels
- **Accumulated Content**: New subscribers instantly receive all previous chunks
- **MessageQueue API**: `subscribeToMessage()` async generator for easy consumption
- **1-hour TTL**: Transient state cleanup after completion

### Unified Streaming
- **Consistent patterns**: Both modes go through the same graph execution
- **Token-level streaming**: Real-time chunks during generation
- **Complete metadata**: Full token counts and performance data at the end
- **Mobile-friendly**: Streams survive app switching and network interruptions

### Graph Structure

```
┌─────────┐
│  Start  │
└────┬────┘
     │
     ▼
┌──────────┐
│  Router  │  ──→ Analyzes query, decides: CHAT, WEB_SEARCH, SCRAPE_URL, or SYSTEM_COMMAND
└────┬─────┘
     │
     ├─────→ CHAT (responder) ─────┐
     │                              │
     ├─────→ WEB_SEARCH (search) ───┤
     │                              │
     ├─────→ SCRAPE_URL (scrape) ───┤
     │                              │
     └─────→ SYSTEM_COMMAND ────────┤
              (command)             │
                                    ▼
                              ┌───────────┐
                              │ Responder │  ──→ Generates final response with context
                              └─────┬─────┘
                                    │
                                    ▼
                              ┌─────────┐
                              │   End   │
                              └─────────┘
```

**Flow:**
1. **Router**: Classifies query intent using structured output (CHAT, WEB_SEARCH, SCRAPE_URL, SYSTEM_COMMAND)
2. **Tool Nodes** (if needed): Execute web search, URL scraping, or system commands via MCP servers
3. **Responder**: Generates response using conversation context (from Context MCP) + tool results
4. **Memory**: Auto-saves messages to MongoDB via Context MCP, updates Redis summaries, generates titles

**MCP Integration:**
- **Context Server**: Manages conversation history, summaries, and message storage
- **Web Server**: Combines web search (Tavily) and URL scraping tools
- **System Server**: Executes whitelisted system commands securely
- **RAG Server**: Vector database operations for retrieval-augmented generation

---

## 📋 Examples

See:
- [`/examples/server.ts`](examples/server.ts) - OpenAI-compatible API server
- [`/examples/client.ts`](examples/client.ts) - Example API client in TypeScript
- [`/examples/SERVER.md`](examples/SERVER.md) - API server documentation and deployment guide
- [`/examples/test-rag.ts`](examples/test-rag.ts) - RAG (vector database) examples
- [`/examples/test-mcp-client.ts`](examples/test-mcp-client.ts) - MCP client usage examples
- [`/examples/test-mcp-registry.ts`](examples/test-mcp-registry.ts) - MCP registry examples
- [`/examples/test-json-extractor.ts`](examples/test-json-extractor.ts) - JSON extraction utilities
- [`/examples/test-tool-logging.ts`](examples/test-tool-logging.ts) - Tool execution logging demos

### Running the API Server

Red AI can be run as an OpenAI-compatible API server, allowing integration with tools like OpenWebUI, Cursor, Continue, and any other OpenAI-compatible client:

```bash
npm run server
```

Then test it:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Red",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

Or use the TypeScript client:

```bash
npx tsx examples/client.ts
```

See [`/examples/SERVER.md`](examples/SERVER.md) for complete documentation.

---

## 🚀 Deployment Options

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
│   │   └── background/    # Background tasks (summarization, titles)
│   ├── lib/
│   │   ├── models.ts      # LLM model configurations
│   │   ├── graphs/
│   │   │   └── red.ts     # Main StateGraph definition
│   │   ├── nodes/
│   │   │   ├── router.ts  # Intelligent routing with structured output
│   │   │   ├── responder.ts  # Final response generation
│   │   │   ├── search.ts  # Web search node
│   │   │   ├── scrape.ts  # URL scraping node
│   │   │   └── command/   # System command execution
│   │   ├── mcp/
│   │   │   ├── client.ts  # MCP JSON-RPC client
│   │   │   ├── server.ts  # MCP server base class
│   │   │   ├── registry.ts # MCP server registry
│   │   │   └── servers/   # MCP server implementations
│   │   │       ├── context.ts  # Conversation context & history
│   │   │       ├── rag.ts      # Vector database operations
│   │   │       ├── web.ts      # Web search & scraping
│   │   │       └── system.ts   # System command execution
│   │   ├── memory/
│   │   │   ├── memory.ts  # MemoryManager (Redis + MongoDB)
│   │   │   ├── queue.ts   # MessageQueue for streaming
│   │   │   ├── database.ts # MongoDB operations
│   │   │   └── vectors.ts # Vector store manager
│   │   ├── logs/
│   │   │   ├── logger.ts  # Structured logging
│   │   │   └── persistent-logger.ts # MongoDB-persisted logs
│   │   └── utils/
│   │       ├── thinking.ts # Extract/log thinking from models
│   │       └── json-extractor.ts # Robust JSON parsing
│   └── mcp-servers.ts     # MCP servers launcher
├── examples/
│   ├── server.ts          # OpenAI-compatible API server
│   ├── client.ts          # Example API client
│   └── test-*.ts          # Various test examples
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

## 🔗 Links

- **GitHub**: [redbtn-io/ai](https://github.com/redbtn-io/ai)
- **LangChain**: [https://js.langchain.com](https://js.langchain.com)
- **LangGraph**: [https://langchain-ai.github.io/langgraphjs](https://langchain-ai.github.io/langgraphjs)

---

## 📞 Support

For questions and support, please open an issue on GitHub.

---

**Built with ❤️ by the Red Button team**
