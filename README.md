# Red AI Library

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

> A powerful, graph-based AI agent library built on LangChain and LangGraph, providing intelligent routing and unified streaming/non-streaming interfaces.

## 🚀 Features

- **Graph-Based Architecture**: Built on LangGraph for flexible, composable AI workflows
- **Intelligent Routing**: Automatic routing based on application context and query analysis
- **Web Search & Scraping**: Built-in tools for real-time web search and content extraction
- **Unified Streaming**: Seamless streaming and non-streaming modes with the same API
- **Stream Reconnection**: Redis-backed message queue with pub/sub for reliable mobile streaming
- **Persistent Memory**: MongoDB for long-term message storage, Redis for hot state and summaries
- **Token Tracking**: Complete access to token usage and performance metrics
- **Type-Safe**: Full TypeScript support with type guards
- **Extensible**: Easy to add custom nodes and graphs

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
  databaseUrl: "http://localhost:5432",
  defaultLlmUrl: "https://llm.example.com"
};

// Initialize and load
const red = new Red(config);
await red.load("my-node");

// Get a response
const response = await red.respond(
  { message: 'Hello!' },
  { source: { application: 'redChat' } }
);

console.log(response.content);  // "Hello! How can I help you?"
```

## 📚 Core Concepts

The Red AI library provides a unified interface for both streaming and non-streaming LLM interactions through a graph-based architecture.

## 📖 API Reference

### Configuration

```typescript
interface RedConfig {
  redisUrl: string;        // Redis connection for global state & hot memory
  vectorDbUrl: string;     // Vector database for embeddings (future)
  databaseUrl: string;     // MongoDB URL for long-term message persistence
  defaultLlmUrl: string;   // Default LLM endpoint (e.g., Ollama)
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
red.localModel     // ChatOllama instance
red.geminiModel    // ChatGoogleGenerativeAI instance (optional)
red.openAIModel    // ChatOpenAI instance (optional)
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
}
```

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

Red can run continuously in an autonomous "thinking" mode:

```typescript
// Start autonomous loop
await red.think();

// Stop when needed
red.stopThinking();
```

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
- **MongoDB (Persistent)**: Complete message history, searchable, survives Redis flushes
- **Executive Summaries**: Auto-generated after 3+ messages for quick context retrieval

### Stream Reconnection Architecture
- **Decoupled Generation**: LLM generation runs independently of HTTP transport
- **Redis Pub/Sub**: Real-time chunk publishing to `message:stream:{messageId}` channels
- **Accumulated Content**: New subscribers instantly receive all previous chunks
- **MessageQueue API**: `subscribeToMessage()` async generator for easy consumption

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
│  Router  │  ──→ Analyzes query, decides: CHAT, SCRAPE_URL, or SEARCH
└────┬─────┘
     │
     ├─────→ CHAT ────────┐
     │                    │
     ├─────→ SCRAPE_URL ──┤
     │          ↓         │
     │     ┌──────────┐   │
     │     │ToolPicker│   │
     │     └────┬─────┘   │
     │          ↓         │
     │     ┌──────────┐   │
     └─────→│ToolNode │   │
               └────┬─────┘
                    ↓
               ┌─────────┐
               │ChatNode │  ──→ Generates final response with context
               └────┬────┘
                    │
                    ▼
               ┌─────────┐
               │   End   │
               └─────────┘
```

**Flow:**
1. **Router**: Classifies query intent (chat, scrape, search)
2. **ToolPicker** (if needed): Selects and executes web search/scrape tools
3. **ToolNode** (if needed): Processes tool results and extracts key info
4. **ChatNode**: Generates response using conversation memory + tool results
5. **Memory**: Auto-saves to MongoDB, updates Redis summaries, generates titles

---

## 📋 Examples

See:
- [`/examples/test-streaming.ts`](examples/test-streaming.ts) - Streaming examples with reconnection
- [`/examples/test-router.ts`](examples/test-router.ts) - Router and tool usage examples
- [`/examples/test-toolnode.ts`](examples/test-toolnode.ts) - Web search and scraping demos
- [`/examples/server.ts`](examples/server.ts) - OpenAI-compatible API server
- [`/examples/client.ts`](examples/client.ts) - Example API client in TypeScript
- [`/examples/SERVER.md`](examples/SERVER.md) - API server documentation and deployment guide

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
│   ├── lib/
│   │   ├── models.ts      # LLM model configurations
│   │   ├── graphs/
│   │   │   └── red.ts     # Main graph definition
│   │   └── nodes/
│   │       ├── chat.ts    # Chat processing node
│   │       └── router.ts  # Routing logic node
├── examples/
│   ├── token-access.ts    # Usage examples
│   ├── server.ts          # OpenAI-compatible API server
│   ├── client.ts          # Example API client
│   ├── test-api.sh        # API testing script
│   ├── SERVER.md          # API server documentation
│   └── API-STATUS.md      # Implementation status
└── README.md              # Documentation
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
