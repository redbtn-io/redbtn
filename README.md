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

# Subscription CLI neurons (worker only; see "Subscription CLI neurons")
CLAUDE_CODE_BIN=claude               # default: `claude` on PATH
CLAUDE_CODE_MAX_CONCURRENT=1         # CLI children per worker
AGY_CLI_BIN=agy                      # default: `agy` on PATH
AGY_CLI_MAX_CONCURRENT=2
AGY_CLI_QUEUE_WAIT_MS=               # default: the step's own timeout
AGY_STATE_DIR=/var/lib/redbtn/agy    # 0700; caches the refreshed OAuth token
AGY_OAUTH_TOKEN=                     # fallback when no neuron names a secret
AGY_INSTALLATION_ID=                 # optional; the CLI generates one if unset
REDBTN_RUN_DIR_ROOT=/tmp/redbtn-run  # per-step private dirs (0700)
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

#### Subscription CLI neurons (`claude-code`, `agy-cli`)

Two providers are not HTTP model endpoints. They spawn a coding-agent CLI as a
child of the neuron step and authenticate it with a flat-rate **subscription**
instead of a metered API key, so a graph can spend a seat rather than a token
budget:

| provider | binary | executor | models |
|---|---|---|---|
| `claude-code` | `claude` | `claudeCodeExecutor.ts` | `opus`, `fable`, `sonnet`, `claude-opus-5`, … |
| `agy-cli` | `agy` (Antigravity) | `agyCliExecutor.ts` | `gemini-3.8-flash` (and `-3.7-`/`-3.6-`), optionally suffixed `-low`/`-medium`/`-high`; `gemini-3.1-pro`; `claude-sonnet-4-6`; `claude-opus-4-6-thinking`; `gpt-oss-120b-medium` |

Both are dispatched before `NeuronRegistry.getModel()` — `createModel` throws
for them on purpose — and both are handed the run's tools over the same per-run
Unix-socket MCP bridge (`lib/mcp/run-bridge.ts`) rather than through
`bindTools()`, because each CLI runs its own agent loop.

```ts
// A neuron document for the Antigravity CLI.
{
  neuronId: 'agy-flash-3-8',
  provider: 'agy-cli',
  endpoint: 'agy-cli://worker',
  model: 'gemini-3.8-flash',
  secretName: 'AGY_OAUTH_TOKEN',   // resolved from redsecrets into `apiKey`
  parameters: { effort: 'high' },  // agy: low | medium | high
}
```

**Credentials.** `secretName` resolves through redsecrets into `apiKey`, as for
every other provider. `claude-code` passes it to the child as
`CLAUDE_CODE_OAUTH_TOKEN`; `agy-cli` cannot, because that CLI reads its
credential from a FILE and rewrites it on refresh, so the executor materialises
it into a per-run private `HOME` and copies a refreshed token back into a
per-worker cache (`AGY_STATE_DIR`, default `/var/lib/redbtn/agy`).

**The tool surface is the whole security model.** Both executors build the
child's environment as an allowlist from nothing — the worker's `MONGODB_URI`,
`REDIS_URL` and `INTERNAL_SERVICE_KEY` never reach a process the model can read
`/proc/self/environ` from, and `agy-cli` additionally excludes `GEMINI_API_KEY`
and `GOOGLE_API_KEY` so a subscription neuron cannot silently answer on the
metered API. Both run with an empty placeholder cwd so no `CLAUDE.md`,
`AGENTS.md` or `.agents/rules/*.md` from an untrusted tree becomes instructions.
`agy-cli` relies on the Antigravity CLI's headless deny-by-default — in print
mode every tool needing a permission nobody granted is auto-denied and the turn
ends — and grants exactly one thing, `mcp(redbtn/*)`. A turn that produced no
text because a tool was denied fails the step with `agy_tool_denied` rather than
writing `""` into graph state.

**Falling back.** A step may name `fallbackNeuronId` to re-run once against a
metered neuron when the CLI itself could not run. See `neuronFallback.ts`:
`agy_rate_limited` (subscription capped), `agy_timeout`, `agy_spawn_failed`,
`agy_queue_timeout`, `agy_failed` and `agy_error_result` hop;
`agy_auth_required` (a human must redo the Google login) and `agy_tool_denied`
(a tripped security guard) deliberately do not.

```ts
{ neuronId: 'agy-flash-3-8', fallbackNeuronId: 'sonnet-5' }
```

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
import { DocumentParser } from '@redbtn/redbtn';

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
