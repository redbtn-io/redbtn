# redbtn

**Graph-based automation engine for building, running, and orchestrating dynamic workflows.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

redbtn is the core engine behind the [redbtn.io](https://redbtn.io) platform. It compiles graph configurations from MongoDB into executable [LangGraph](https://langchain-ai.github.io/langgraphjs/) workflows at runtime, with per-user model routing, tiered access control, and MCP tool integration.

```ts
import { Red } from '@redbtn/redbtn';

const engine = new Red({
  redisUrl: process.env.REDIS_URL,
  vectorDbUrl: process.env.CHROMA_URL,
  databaseUrl: process.env.MONGODB_URL,
  chatLlmUrl: process.env.OLLAMA_URL,
  workLlmUrl: process.env.OLLAMA_URL,
});

await engine.load();

const result = await engine.run(
  { message: 'Summarize my recent emails' },
  { userId: 'user_123', stream: true }
);
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                       Red Engine                         │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │   Graphs    │  │   Neurons   │  │   Connections   │  │
│  │  (workflows)│  │   (models)  │  │  (OAuth/creds)  │  │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  │
│         │                │                   │           │
│  ┌──────▼──────────────────────────────────────────────┐ │
│  │              Universal Node Executor                │ │
│  │   JIT-compiled graphs → LangGraph StateGraph        │ │
│  └──────┬──────────────────────────────────┬───────────┘ │
│         │                                  │             │
│  ┌──────▼──────┐                    ┌──────▼──────┐      │
│  │   Memory    │                    │  MCP Tools  │      │
│  │ Redis/Mongo │                    │ stdio/HTTP  │      │
│  │  /ChromaDB  │                    │  /user SSE  │      │
│  └─────────────┘                    └─────────────┘      │
└──────────────────────────────────────────────────────────┘
```

### Key Systems

| System | Description |
|--------|-------------|
| **Graph Registry** | Loads graph configs from MongoDB, JIT-compiles into LangGraph `StateGraph` instances with LRU caching (5min TTL) |
| **Neuron Registry** | Per-user model assignment — maps graph nodes to LLM providers (Ollama, OpenAI, Anthropic, Google) with tier-based access |
| **Universal Nodes** | All graph nodes route through a single executor that loads config by `nodeId`, resolves the model, runs the prompt, and handles tools |
| **MCP Integration** | Three-layer tool resolution: user custom servers → global stdio servers → external HTTP/SSE servers |
| **Run System** | Execution orchestrator with Redis pub/sub for real-time streaming, run locking, and state tracking |
| **Memory** | Three-tier: Redis (hot state, pub/sub), MongoDB (conversations, logs), ChromaDB (vector search / RAG) |
| **Connections** | OAuth credential manager with encrypted storage, token refresh, and per-user provider linking |

---

## Installation

```bash
npm install @redbtn/redbtn
```

Peer dependencies:
```bash
npm install @red/stream @redbtn/redlog
```

### Environment Variables

```env
# Required
MONGODB_URL=mongodb://localhost:27017/redbtn
REDIS_URL=redis://localhost:6379

# LLM Endpoints
OLLAMA_URL=http://localhost:11434
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...

# Vector DB (RAG)
CHROMA_URL=http://localhost:8000

# Web Search (optional)
GOOGLE_SEARCH_API_KEY=...
GOOGLE_SEARCH_CX=...
```

---

## Core Concepts

### Graphs

Graphs are the workflow definitions — stored in MongoDB as JSON configs with nodes and edges. The engine compiles them into LangGraph `StateGraph` instances at runtime.

```ts
// Graphs are user-owned and versioned
const graph = await engine.graphRegistry.getGraph(graphId, userId);

// Or run directly through the engine
await engine.run({ message: 'hello' }, { userId, graphId });
```

Each graph node references a **node config** (prompt template, tool permissions, output format) and routes through the universal node executor.

### Neurons

Neurons map node roles to LLM providers. Each user can override which model handles each role in their graphs.

```ts
// User's neuron config might look like:
// { chat: 'gpt-4o', reasoning: 'claude-3-opus', fast: 'llama3.1' }
const neuron = await engine.neuronRegistry.getNeuronForUser(userId, role);
```

Tier-based access (levels 0–4) controls which models and graphs a user can access.

### MCP Tools

Tools are exposed via the [Model Context Protocol](https://modelcontextprotocol.io/). The engine resolves tools through three layers:

1. **User custom** — per-user MCP server connections stored in MongoDB
2. **Global stdio** — built-in tool servers (web search, scraping, file ops)
3. **External HTTP/SSE** — remote MCP servers registered at startup

```ts
const result = await engine.callMcpTool('web_search', { query: 'latest news' }, { userId });

// List all available tools (global + user's custom)
const { tools, count } = await engine.getAllTools(userId);
```

### Run System

The run system handles execution lifecycle with real-time streaming via Redis pub/sub:

```ts
import { RunPublisher, RunLock, acquireRunLock } from '@redbtn/redbtn';

// Acquire a lock to prevent concurrent runs on the same conversation
const lock = await acquireRunLock({ conversationId, userId });

// Publisher pushes events to Redis for SSE consumers
const publisher = new RunPublisher({ redis, runId });
await publisher.publish({ type: 'chunk', content: 'Hello' });
await publisher.publish({ type: 'done' });
```

---

## API Reference

### `Red` Class

| Method | Description |
|--------|-------------|
| `load(nodeId?)` | Initialize engine — connects to MongoDB, Redis, starts MCP servers, begins heartbeat |
| `run(input, options)` | Execute a graph with streaming support. Requires `userId` |
| `callMcpTool(name, args, ctx?)` | Call an MCP tool with automatic routing and logging |
| `getAllTools(userId?)` | Get all available tools with source metadata |
| `think()` | Start autonomous cognition loop (experimental) |
| `shutdown()` | Graceful shutdown — stops heartbeat, closes connections, kills MCP servers |

### Exported Utilities

```ts
// Database
import { getDatabase, DatabaseManager } from '@redbtn/redbtn';

// Run system
import { RunPublisher, RunLock, acquireRunLock } from '@redbtn/redbtn';

// Connections (OAuth/credentials)
import { ConnectionManager, decryptCredentials } from '@redbtn/redbtn';

// Document parsing
import { DocumentParser, PDFParser, DocxParser } from '@redbtn/redbtn';

// Logging (re-exported from @redbtn/redlog)
import { RedLog, LogReader, LogStream } from '@redbtn/redbtn';

// Graph/Neuron registries
import { GraphRegistry, NeuronRegistry } from '@redbtn/redbtn';
```

---

## Project Structure

```
src/
├── index.ts              # Public API exports
├── mcp-servers.ts        # MCP server launcher (SSE transport)
├── functions/
│   ├── run.ts            # Core graph execution function
│   └── background/       # Heartbeat, title generation, cleanup
└── lib/
    ├── connections/      # OAuth credential manager
    ├── events/           # Event system
    ├── globalState/      # Cross-workflow Redis state
    ├── graphs/           # Graph registry, compiler, conditions
    ├── mcp/              # MCP client, registry, stdio pool, user manager
    ├── memory/           # Database, vectors, message queue
    ├── models/           # Mongoose models (Graph, Node, Neuron, etc.)
    ├── neurons/          # Neuron registry (per-user model routing)
    ├── nodes/universal/  # Universal node executor
    ├── parsers/          # Document parsers (PDF, DOCX, images)
    ├── registry/         # Model registry
    ├── run/              # Run publisher, locking, state
    ├── types/            # TypeScript type definitions
    └── utils/            # Helpers (thinking extraction, etc.)
```

---

## Development

```bash
# Build
npm run build

# Test
npm test

# Lint
npm run lint

# Pack for distribution
npm run pack
```

### Database Scripts

```bash
npm run db:seed-neurons          # Seed default neuron configs
npm run db:seed-graphs           # Seed default graph configs
npm run db:update-user-defaults  # Update user defaults
```

---

## Related Packages

| Package | Description |
|---------|-------------|
| [`@red/stream`](https://github.com/redbtn-io/redstream) | Redis streaming, pub/sub, BullMQ queue factory |
| [`@redbtn/redlog`](https://github.com/redbtn-io/redlog) | Structured logging with Redis pub/sub and MongoDB persistence |
| [`@redbtn/redstyle`](https://github.com/redbtn-io/redsign) | Shared UI components and design tokens |

---

## License

ISC
