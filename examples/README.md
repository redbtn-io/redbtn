# Red AI Examples

This directory contains working examples of how to use the Red AI library in different contexts. Each example is self-contained with its own dependencies to avoid cluttering the main library.

## 📂 Available Examples

### 🤖 [Discord Bot](./discord)
Full-featured Discord bot that responds when mentioned in channels.

**Features:**
- Tag-based activation
- Per-channel conversation management
- Multi-user context with `[username]: [message]` format
- Streaming responses with typing indicators
- Automatic message chunking

**Setup:**
```bash
cd discord
npm install
# Configure .env with DISCORD_BOT_TOKEN
npm start
```

See [discord/README.md](./discord/README.md) for detailed setup instructions.

---

### 🌐 [REST API Server](./rest-server)
OpenAI-compatible API server for Red AI.

**Features:**
- OpenAI Chat Completions API format
- Streaming and non-streaming modes
- Works with OpenWebUI, Cursor, Continue, etc.
- Bearer token authentication
- CORS support

**Setup:**
```bash
cd rest-server
npm install
# Configure .env with LLM endpoints
npm start
```

Includes a TypeScript client example (`client.ts`) for testing.

See [rest-server/README.md](./rest-server/README.md) for detailed setup instructions.

---

## 🏗️ Structure

Each example is organized as follows:

```
examples/
├── discord/
│   ├── package.json          # Discord-specific dependencies
│   ├── discord-bot.ts        # Main bot implementation
│   ├── start-discord-bot.sh  # Quick-start script
│   └── README.md             # Setup & usage guide
│
└── rest-server/
    ├── package.json          # Server-specific dependencies
    ├── server.ts             # OpenAI-compatible API server
    ├── client.ts             # Example TypeScript client
    └── README.md             # Setup & usage guide
```

## 📦 Dependencies

Each example has its own `package.json` with specific dependencies:

- **Discord Bot**: `discord.js`, `@redbtn/ai`
- **REST Server**: `express`, `cors`, `@redbtn/ai`

This approach keeps the main Red AI library lean while providing rich examples.

## 🚀 Getting Started

1. **Choose an example** from the list above
2. **Navigate to the example directory**
3. **Install dependencies**: `npm install`
4. **Configure environment** (see each README for details)
5. **Run the example**: `npm start`

## 🔧 Common Prerequisites

All examples require:

- **Node.js** 18+ (with TypeScript support via `tsx`)
- **Redis** - For state management and pub/sub
- **MongoDB** - For conversation persistence
- **Vector DB** (ChromaDB) - For semantic memory
- **MCP Servers** - Model Context Protocol servers (run from main library)

### Starting MCP Servers

MCP servers must be running for the examples to work:

```bash
# From the main library directory
cd ../..
npm run mcp:start
```

This starts:
- Context Server (conversation history)
- Web Server (search & scraping)
- System Server (command execution)
- RAG Server (vector database)

## 📝 Environment Variables

Common environment variables across examples:

```bash
# Redis
REDIS_URL=redis://localhost:6379

# Vector Database
VECTOR_DB_URL=http://localhost:8200

# MongoDB
DATABASE_URL=mongodb://localhost:27017/red-webapp

# LLM Endpoints
CHAT_LLM_URL=http://192.168.1.4:11434  # Primary chat model
WORK_LLM_URL=http://192.168.1.3:11434  # Worker model for routing/tools
```

Example-specific variables are documented in each example's README.

## 🛠️ Development

### Using tsx (TypeScript Execution)

All examples use `tsx` for running TypeScript directly without compilation:

```bash
npx tsx server.ts
```

### Watch Mode

For development with auto-reload:

```bash
npm run dev  # Available in each example
```

## 📚 Additional Resources

- **Main Documentation**: [../../README.md](../../README.md)
- **MCP Documentation**: [../../RAG-SYSTEM.md](../../RAG-SYSTEM.md)
- **API Reference**: See main README

## 🤝 Contributing

To add a new example:

1. Create a new directory under `examples/`
2. Add a `package.json` with example-specific dependencies
3. Include a comprehensive `README.md`
4. Update this file to list the new example
5. Ensure imports use `@redbtn/ai` (not relative paths)

## 📄 License

ISC License - see the [LICENSE](../../LICENSE) file for details.

---

**Built with ❤️ by the Red Button team**
